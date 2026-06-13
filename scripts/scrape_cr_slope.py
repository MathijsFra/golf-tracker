#!/usr/bin/env python3
"""
Backfill CR/slope voor alle golfbanen via de mijn.golf.nl interne API.

Strategie (ontdekt via reverse-engineering van /mijn-spel/scores/scorekaart-aanmaken):
  1. Login op golf.nl en haal het scorekaart-aanmaakformulier op → alle 248 NL-banen
     met hun interne courseId staan in <select id="form-course">.
  2. Voor elke baan met ontbrekende CR/slope: match de clubnaam op golf.nl en roep
     GET /api/mygame/getcourse?courseId=<id> aan.
     Dit endpoint geeft Loops[] met Categories[] die CourseRating + SlopeRating bevatten.
  3. Koppel elke Category via CategoryIndex aan de standaard KNLTB teekleur:
     8=Wit/man, 9=Geel/man, 10=Blauw/man, 11=Rood/man, 12=Oranje/man,
     13=Wit/vrouw, 14=Geel/vrouw, 15=Rood/vrouw, 16=Oranje/vrouw.
  4. Sla CR+slope op in course_tees via een directe PATCH (geen scorekaartpagina nodig).

Gebruik:
  python scripts/scrape_cr_slope.py [backfill|status]

Env vars:
  SUPABASE_URL, SUPABASE_SERVICE_KEY  — database
  GOLF_USER_ID                        — optioneel: beperkt tot één account
  LOG_LEVEL=DEBUG                     — uitgebreide output
"""

import json
import os
import re
import sys
import time

import requests
from bs4 import BeautifulSoup

from golfutil import run_main, require_env, setup_logging, request_with_retry
import sync_golfnl as _gn
from sync_golfnl import (
    golfnl_login,
    sb_get_user_settings,
    supabase_headers,
    SUPABASE_URL,
    UA,
)

log = setup_logging("scrape_cr_slope")

GOLF_USER_ID = os.environ.get("GOLF_USER_ID", "")

SCORECARD_CREATE_URL = "https://mijn.golf.nl/mijn-spel/scores/scorekaart-aanmaken"
GETCOURSE_URL = "https://mijn.golf.nl/api/mygame/getcourse"

# Standaard KNLTB CategoryIndex → (teekleur, geslacht)
# Bevestigd door PHcp-matching op Golf Club Zeewolde 18h Aak-Botter.
CATEGORY_MAP: dict[int, tuple[str, str]] = {
    8:  ("Wit",    "male"),
    9:  ("Geel",   "male"),
    10: ("Blauw",  "male"),
    11: ("Rood",   "male"),
    12: ("Oranje", "male"),
    13: ("Wit",    "female"),
    14: ("Geel",   "female"),
    15: ("Rood",   "female"),
    16: ("Oranje", "female"),
}


# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def sb_get(path: str, params: str = "") -> list[dict]:
    url = f"{SUPABASE_URL}/rest/v1/{path}{params}"
    resp = requests.get(url, headers=supabase_headers(), timeout=20)
    resp.raise_for_status()
    return resp.json()


def sb_patch(path: str, body: dict) -> None:
    resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={**supabase_headers(), "Prefer": "return=minimal"},
        data=json.dumps(body),
        timeout=15,
    )
    resp.raise_for_status()


# ---------------------------------------------------------------------------
# golf.nl API helpers
# ---------------------------------------------------------------------------

def fetch_course_options(session: requests.Session) -> dict[str, int]:
    """Haal alle clubnamen + courseIds op uit het scorekaart-aanmaakformulier."""
    r = request_with_retry(
        "GET", SCORECARD_CREATE_URL, session=session,
        headers={"Referer": "https://mijn.golf.nl/dashboard"},
    )
    soup = BeautifulSoup(r.text, "html.parser")
    options: dict[str, int] = {}
    for opt in soup.select("#form-course option"):
        val = opt.get("value", "")
        name = opt.get_text(strip=True)
        if val and name and str(val).isdigit():
            options[name] = int(val)
    log.info("%d golfbanen gevonden in scorekaart-formulier.", len(options))
    return options


def fetch_course_data(session: requests.Session, course_id: int) -> dict:
    """Haal lussen + CR/slope op voor één baan via de interne API."""
    r = request_with_retry(
        "GET", f"{GETCOURSE_URL}?courseId={course_id}", session=session,
        headers={
            "Referer": SCORECARD_CREATE_URL,
            "X-Requested-With": "XMLHttpRequest",
        },
    )
    return r.json()


def loop_holes(loop_name: str) -> int | None:
    """Parseer het aantal holes uit de loop-naam (bijv. '18 holes Aak-Botter' → 18)."""
    m = re.match(r"(\d+)\s*holes?", loop_name or "", re.IGNORECASE)
    return int(m.group(1)) if m else None


def find_course_id(options: dict[str, int], club_name: str) -> int | None:
    """Zoek een golf.nl courseId op basis van clubnaam (exact → case-insensitief → substring)."""
    if club_name in options:
        return options[club_name]
    lower = club_name.lower()
    for name, cid in options.items():
        if name.lower() == lower:
            return cid
    for name, cid in options.items():
        if lower in name.lower() or name.lower() in lower:
            return cid
    return None


# ---------------------------------------------------------------------------
# Kern logica
# ---------------------------------------------------------------------------

def get_rounds_missing_cr_slope(user_id: str) -> list[dict]:
    """Rondes met scorecard_id + course_tee_id maar zonder CR/slope in de tee."""
    rounds = sb_get(
        "rounds",
        f"?select=id,course_tee_id,course,tee,holes"
        f"&golfnl_scorecard_id=not.is.null"
        f"&course_tee_id=not.is.null"
        f"&user_id=eq.{user_id}"
        f"&deleted_at=is.null",
    )
    if not rounds:
        return []

    tee_ids = list({r["course_tee_id"] for r in rounds if r.get("course_tee_id")})
    if not tee_ids:
        return []

    ids_csv = ",".join(tee_ids)
    tees = sb_get("course_tees", f"?id=in.({ids_csv})&select=id,tee_name,course_rating,slope_rating")
    tees_by_id = {t["id"]: t for t in tees}

    missing = []
    for r in rounds:
        tee = tees_by_id.get(r.get("course_tee_id"))
        if tee and (tee.get("course_rating") is None or tee.get("slope_rating") is None):
            r["_tee_id"] = tee["id"]
            r["_tee_name"] = tee.get("tee_name") or r.get("tee") or ""
            missing.append(r)

    log.info(
        "Gebruiker %s: %d ronde(s) met ontbrekende CR/slope (van %d totaal).",
        user_id, len(missing), len(rounds),
    )
    return missing


def update_course_tee(tee_id: str, course_rating, slope_rating) -> bool:
    patch: dict = {}
    if course_rating is not None:
        patch["course_rating"] = course_rating
    if slope_rating is not None:
        patch["slope_rating"] = slope_rating
    if not patch:
        return False
    sb_patch(f"course_tees?id=eq.{tee_id}", patch)
    return True


def backfill_one_user(username: str, password: str, user_id: str) -> tuple[int, int]:
    """Backfill CR/slope voor één gebruiker. Geeft (bijgewerkt, mislukt) terug."""
    _gn.GOLFNL_USERNAME = username
    _gn.GOLFNL_PASSWORD = password

    missing = get_rounds_missing_cr_slope(user_id)
    if not missing:
        log.info("Geen rondes met ontbrekende CR/slope voor gebruiker %s.", user_id)
        return 0, 0

    session = requests.Session()
    session.headers.update({"User-Agent": UA})
    log.info("Inloggen op golf.nl voor gebruiker %s…", user_id)
    golfnl_login(session)

    log.info("Scorekaart-formulier ophalen voor baan-ID mapping…")
    course_options = fetch_course_options(session)

    # Verwerk per unieke tee (meerdere rondes op dezelfde tee → één API-aanroep)
    seen_tees: set[str] = set()
    # Cache courseId → course_data om herhaalde API-aanroepen te voorkomen
    course_cache: dict[int, dict] = {}
    updated = failed = 0

    for r in missing:
        tee_id = r["_tee_id"]
        if tee_id in seen_tees:
            continue

        club_name = r.get("course", "")
        tee_name = r.get("_tee_name", "")
        holes = r.get("holes") or 18

        course_id = find_course_id(course_options, club_name)
        if not course_id:
            log.warning("Geen golf.nl baan gevonden voor '%s' — overgeslagen.", club_name)
            seen_tees.add(tee_id)
            failed += 1
            continue

        try:
            if course_id not in course_cache:
                course_cache[course_id] = fetch_course_data(session, course_id)
                time.sleep(0.2)

            course_data = course_cache[course_id]
            loops = course_data.get("Loops") or []

            # Selecteer lussen die overeenkomen met het juiste aantal holes
            matching_loops = [l for l in loops if loop_holes(l.get("LoopName", "")) == holes]
            if not matching_loops:
                matching_loops = loops  # vangnet: gebruik alle lussen

            cr = slope = None
            for loop in matching_loops:
                for cat in loop.get("Categories") or []:
                    cat_tee, _ = CATEGORY_MAP.get(cat.get("CategoryIndex", -1), (None, None))
                    if cat_tee and cat_tee.lower() == tee_name.lower():
                        cr = cat.get("CourseRating")
                        slope = cat.get("SlopeRating")
                        log.debug(
                            "Match: baan=%s (%s) lus=%s tee=%s → CR=%s Slope=%s",
                            club_name, course_id, loop.get("LoopName"), tee_name, cr, slope,
                        )
                        break
                if cr is not None or slope is not None:
                    break

            if cr is not None or slope is not None:
                update_course_tee(tee_id, cr, slope)
                updated += 1
                log.info(
                    "Tee %s (%s %s): CR=%s Slope=%s opgeslagen.",
                    tee_id, club_name, tee_name, cr, slope,
                )
            else:
                log.warning(
                    "Geen CR/slope gevonden voor %s / %s (tee '%s' niet in CategoryMap?).",
                    club_name, holes, tee_name,
                )
                failed += 1

            seen_tees.add(tee_id)

        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("Fout bij %s (courseId=%s): %s", club_name, course_id, e)

    log.info(
        "Gebruiker %s klaar — %d tee(s) bijgewerkt, %d mislukt.",
        user_id, updated, failed,
    )
    return updated, failed


# ---------------------------------------------------------------------------
# Statusoverzicht
# ---------------------------------------------------------------------------

def print_status() -> None:
    total = sb_get(
        "rounds",
        "?select=id&golfnl_scorecard_id=not.is.null&course_tee_id=not.is.null&deleted_at=is.null",
    )
    with_cr = sb_get(
        "course_tees",
        "?select=id&course_rating=not.is.null&slope_rating=not.is.null",
    )
    without_cr = sb_get(
        "course_tees",
        "?select=id&or=(course_rating.is.null,slope_rating.is.null)",
    )
    print(f"\n=== CR/slope voortgang ===")
    print(f"Rondes met scorecard_id + tee: {len(total)}")
    print(f"Tees met beide CR+slope:        {len(with_cr)}")
    print(f"Tees zonder (een van) CR/slope: {len(without_cr)}")
    print()


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    mode = sys.argv[1].lower() if len(sys.argv) > 1 else "backfill"

    require_env("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not supabase_key:
        log.error("Geen Supabase-key: stel SUPABASE_SERVICE_KEY in.")
        sys.exit(2)

    if mode == "status":
        print_status()
        return

    users = sb_get_user_settings()
    if GOLF_USER_ID and users:
        users = [u for u in users if u["user_id"] == GOLF_USER_ID]

    golfnl_env_user = os.environ.get("GOLFNL_USERNAME", "")
    golfnl_env_pass = os.environ.get("GOLFNL_PASSWORD", "")
    if not users and golfnl_env_user and golfnl_env_pass and GOLF_USER_ID:
        users = [{"user_id": GOLF_USER_ID, "golfnl_username": golfnl_env_user,
                  "golfnl_password": golfnl_env_pass}]

    if not users:
        log.error("Geen gebruikers met GOLF.NL-credentials. Stel ze in via de app.")
        sys.exit(2)

    log.info("%d gebruiker(s) te verwerken.", len(users))
    total_updated = total_failed = 0
    for u in users:
        upd, fail = backfill_one_user(
            u["golfnl_username"], u["golfnl_password"], u["user_id"],
        )
        total_updated += upd
        total_failed += fail

    log.info("Klaar — %d tee(s) bijgewerkt, %d mislukt.", total_updated, total_failed)
    if total_failed > 0 and total_updated == 0:
        sys.exit(1)


if __name__ == "__main__":
    run_main(main)
