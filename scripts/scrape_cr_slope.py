#!/usr/bin/env python3
"""
Vul de database met CR/slope voor alle Nederlandse golfbanen via de
mijn.golf.nl interne API.

Eenmalig of een paar keer per jaar uitvoeren om de course_tees-tabel compleet
te houden. Verwerkt alle ~248 banen — niet gebruikersspecifiek.

Aanpak (reverse-engineering van /mijn-spel/scores/scorekaart-aanmaken):
  1. Login op golf.nl; alle banen staan in <select id="form-course">.
  2. Per baan: GET /api/mygame/getcourse?courseId=<id>
     → Loops[] met Categories[] die CourseRating + SlopeRating bevatten.
  3. CategoryIndex → (teekleur, geslacht) via standaard KNLTB-mapping:
       8=Wit/man  9=Geel/man  10=Blauw/man  11=Rood/man  12=Oranje/man
       13=Wit/vrouw  14=Geel/vrouw  15=Rood/vrouw  16=Oranje/vrouw
  4. Upsert: club → lus (course) → tee met CR+slope.

Gebruik:
  python scripts/scrape_cr_slope.py [fill-all|status]

Env vars:
  SUPABASE_URL, SUPABASE_SERVICE_KEY — database
  GOLFNL_USERNAME, GOLFNL_PASSWORD  — één golf.nl-account (alleen voor de login)
  LOG_LEVEL=DEBUG                   — uitgebreide output
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

SCORECARD_CREATE_URL = "https://mijn.golf.nl/mijn-spel/scores/scorekaart-aanmaken"
GETCOURSE_URL = "https://mijn.golf.nl/api/mygame/getcourse"

# Standaard KNLTB CategoryIndex → (teekleur, geslacht)
# Bevestigd via PHcp-matching op Golf Club Zeewolde 18h Aak-Botter.
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

# Vertraging tussen API-aanroepen om de server niet te overbelasten.
REQUEST_DELAY = 0.3  # seconden


# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def sb_post(path: str, body: dict) -> list[dict]:
    resp = request_with_retry(
        "POST",
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={**supabase_headers(), "Prefer": "resolution=merge-duplicates,return=representation"},
        data=json.dumps(body),
        timeout=15,
    )
    result = resp.json()
    if not isinstance(result, list) or not result:
        raise RuntimeError(f"Supabase upsert gaf geen rij terug voor {path}: {resp.text[:200]}")
    return result


def sb_get(path: str, params: str = "") -> list[dict]:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/{path}{params}",
        headers=supabase_headers(),
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# golf.nl API helpers
# ---------------------------------------------------------------------------

def fetch_course_options(session: requests.Session) -> list[tuple[str, int]]:
    """Haal alle (clubnaam, courseId)-paren op uit het scorekaart-formulier."""
    r = request_with_retry(
        "GET", SCORECARD_CREATE_URL, session=session,
        headers={"Referer": "https://mijn.golf.nl/dashboard"},
    )
    soup = BeautifulSoup(r.text, "html.parser")
    options = []
    for opt in soup.select("#form-course option"):
        val = opt.get("value", "")
        name = opt.get_text(strip=True)
        if val and name and str(val).isdigit():
            options.append((name, int(val)))
    log.info("%d golfbanen gevonden in het scorekaart-formulier.", len(options))
    return options


def fetch_course_data(session: requests.Session, course_id: int) -> dict:
    """Haal lussen + CR/slope op voor één baan (interne golf.nl API)."""
    r = request_with_retry(
        "GET", f"{GETCOURSE_URL}?courseId={course_id}", session=session,
        headers={
            "Referer": SCORECARD_CREATE_URL,
            "X-Requested-With": "XMLHttpRequest",
        },
    )
    return r.json()


def loop_holes(loop_name: str) -> int | None:
    """Parseer het aantal holes uit de loop-naam ('18 holes Aak-Botter' → 18)."""
    m = re.match(r"(\d+)\s*holes?", loop_name or "", re.IGNORECASE)
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------------------
# Database upsert
# ---------------------------------------------------------------------------

def upsert_club(club_name: str) -> str:
    rows = sb_post(
        "clubs?on_conflict=name,country",
        {"name": club_name, "country": "NL", "updated_at": "now()"},
    )
    return rows[0]["id"]


def upsert_course(club_id: str, club_name: str, loop_name: str) -> str:
    rows = sb_post(
        "courses?on_conflict=club_id,loop_name",
        {"club_id": club_id, "loop_name": loop_name, "name": club_name,
         "country": "NL", "updated_at": "now()"},
    )
    return rows[0]["id"]


def upsert_tee(
    course_id: str,
    holes: int,
    tee_name: str,
    tee_gender: str,
    course_rating: float | None,
    slope_rating: int | None,
) -> None:
    """Upsert één tee met CR/slope (club en lus zijn al gecached)."""
    tee_row: dict = {
        "course_id":  course_id,
        "tee_name":   tee_name,
        "tee_gender": tee_gender,
        "holes":      holes,
    }
    if course_rating is not None:
        tee_row["course_rating"] = course_rating
    if slope_rating is not None:
        tee_row["slope_rating"] = slope_rating
    sb_post("course_tees?on_conflict=course_id,tee_name,tee_gender,holes", tee_row)


# ---------------------------------------------------------------------------
# Hoofd-logica
# ---------------------------------------------------------------------------

def fill_all(session: requests.Session) -> tuple[int, int, int]:
    """
    Verwerk alle banen en sla CR/slope op voor elke lus + tee.
    Club en lus worden per baan één keer gecached om onnodige Supabase-calls
    te vermijden. Geeft (verwerkte banen, opgeslagen tees, mislukte banen) terug.
    """
    courses = fetch_course_options(session)
    if not courses:
        log.error("Geen banen gevonden — ingelogd maar formulier leeg?")
        return 0, 0, 0

    processed = saved = failed = 0
    club_cache: dict[str, str] = {}      # club_name → club_id
    course_cache: dict[tuple, str] = {}  # (club_id, loop_name) → course_id

    for idx, (club_name, course_id) in enumerate(courses, 1):
        log.info("[%d/%d] %s (courseId=%d)…", idx, len(courses), club_name, course_id)
        try:
            data = fetch_course_data(session, course_id)
            loops = data.get("Loops") or []

            # Club één keer opslaan per naam
            if club_name not in club_cache:
                club_cache[club_name] = upsert_club(club_name)
            club_id = club_cache[club_name]

            for loop in loops:
                loop_name = loop.get("LoopName", "")
                holes = loop_holes(loop_name) or 18
                categories = loop.get("Categories") or []

                # Lus één keer opslaan per (club, loop_name)
                cache_key = (club_id, loop_name)
                if cache_key not in course_cache:
                    course_cache[cache_key] = upsert_course(club_id, club_name, loop_name)
                db_course_id = course_cache[cache_key]

                for cat in categories:
                    cat_idx = cat.get("CategoryIndex", -1)
                    tee_name, tee_gender = CATEGORY_MAP.get(cat_idx, (None, None))
                    if not tee_name:
                        continue  # onbekende categorie

                    cr = cat.get("CourseRating")
                    slope = cat.get("SlopeRating")
                    if cr is None and slope is None:
                        continue  # geen data, overslaan

                    upsert_tee(db_course_id, holes, tee_name, tee_gender, cr, slope)
                    saved += 1
                    log.debug(
                        "  %s / %s / %s (%s) → CR=%s Slope=%s",
                        club_name, loop_name, tee_name, tee_gender, cr, slope,
                    )

            processed += 1

        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("Fout bij %s (courseId=%d): %s", club_name, course_id, e)

        time.sleep(REQUEST_DELAY)

    return processed, saved, failed


# ---------------------------------------------------------------------------
# Statusoverzicht
# ---------------------------------------------------------------------------

def print_status() -> None:
    clubs    = sb_get("clubs",       "?select=id&country=eq.NL")
    courses  = sb_get("courses",     "?select=id")
    tees     = sb_get("course_tees", "?select=id")
    with_cr  = sb_get("course_tees", "?select=id&course_rating=not.is.null&slope_rating=not.is.null")
    no_cr    = sb_get("course_tees", "?select=id&or=(course_rating.is.null,slope_rating.is.null)")

    print("\n=== CR/slope databasestatus ===")
    print(f"Clubs (NL):              {len(clubs)}")
    print(f"Lussen (courses):        {len(courses)}")
    print(f"Tees totaal:             {len(tees)}")
    print(f"  met CR + slope:        {len(with_cr)}")
    print(f"  zonder (een van) both: {len(no_cr)}")
    print()


# ---------------------------------------------------------------------------
# Inloggen — één account volstaat
# ---------------------------------------------------------------------------

def get_credentials() -> tuple[str, str]:
    """Haal golf.nl-credentials op (env vars → eerste gebruiker in DB)."""
    username = os.environ.get("GOLFNL_USERNAME", "")
    password = os.environ.get("GOLFNL_PASSWORD", "")
    if username and password:
        return username, password

    users = sb_get_user_settings()
    if users:
        return users[0]["golfnl_username"], users[0]["golfnl_password"]

    raise RuntimeError(
        "Geen golf.nl-credentials gevonden. Stel GOLFNL_USERNAME + GOLFNL_PASSWORD in "
        "of sla ze op via de app."
    )


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    mode = (sys.argv[1].lower() if len(sys.argv) > 1 else "fill-all").replace("_", "-")

    require_env("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not supabase_key:
        log.error("Geen Supabase-key: stel SUPABASE_SERVICE_KEY in.")
        sys.exit(2)

    if mode == "status":
        print_status()
        return

    if mode not in ("fill-all", "backfill"):
        log.error("Onbekende modus '%s'. Kies 'fill-all' of 'status'.", mode)
        sys.exit(2)

    username, password = get_credentials()
    _gn.GOLFNL_USERNAME = username
    _gn.GOLFNL_PASSWORD = password

    session = requests.Session()
    session.headers.update({"User-Agent": UA})
    log.info("Inloggen op golf.nl…")
    golfnl_login(session)

    log.info("Start vullen van alle banen (CR/slope)…")
    processed, saved, failed = fill_all(session)

    log.info(
        "Klaar — %d banen verwerkt, %d tees opgeslagen, %d banen mislukt.",
        processed, saved, failed,
    )
    if failed > 0 and processed == 0:
        sys.exit(1)


if __name__ == "__main__":
    run_main(main)
