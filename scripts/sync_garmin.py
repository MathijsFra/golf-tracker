#!/usr/bin/env python3
"""
Sync Garmin Connect shot-stats -> Supabase, per gebruiker.

GOLF.NL levert datum/baan/score/par-per-hole; Garmin levert de shot-stats
(putts, fairways, penalties). Dit script haalt Garmin-scorekaarten op voor
alle gebruikers die hun Garmin-credentials hebben opgeslagen, matcht ze op
datum aan de rondes in Supabase, en vult per hole putts/fairway/penalties aan
in `holes_data`. GIR wordt zelf berekend uit par en (slagen - putts).

Vereiste environment variables:
  SUPABASE_URL, SUPABASE_SERVICE_KEY   - Supabase project

Lokale debug (dump ruwe Garmin-JSON voor één account):
    GARMIN_EMAIL=... GARMIN_PASSWORD=... python scripts/sync_garmin.py --dump
"""

import os
import sys
import json
import datetime as dt
from garminconnect import Garmin

from golfutil import setup_logging, require_env, request_with_retry, retry_call, run_main

log = setup_logging("garmin")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")


# ============================================================
#  Garmin: inloggen per gebruiker
# ============================================================
def garmin_login_token(token_str: str) -> Garmin:
    """Inloggen met een opgeslagen sessie-token (geen OTP nodig)."""
    g = Garmin()
    try:
        # garth-gebaseerd API (>=0.2.x): laad token via garth.loads()
        g.garth.loads(token_str)
        g.display_name = g.garth.profile.get("displayName")
        g.full_name = g.garth.profile.get("fullName")
    except AttributeError:
        # Oudere versie: tokenstore= parameter
        g.login(tokenstore=token_str)
    return g


def garmin_login_password(email: str, password: str) -> Garmin:
    """Inloggen met email + wachtwoord (fallback; mislukt als OTP vereist is)."""
    g = Garmin(email=email, password=password)
    g.login()
    return g


def as_list(data) -> list:
    """Garmin geeft soms een lijst, soms een dict met de lijst onder een sleutel."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("scorecardSummaries", "scorecards", "summaries", "data"):
            if isinstance(data.get(key), list):
                return data[key]
        for v in data.values():
            if isinstance(v, list):
                return v
    return []


def pick(d: dict, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d[k]
    return None


def scorecard_date(summary: dict) -> str | None:
    raw = pick(summary, "startTime", "scorecardStartTime", "playedTime",
               "scorecardDate", "startDate", "date")
    if raw is None:
        return None
    s = str(raw)
    if s.isdigit():
        ts = int(s)
        if ts > 10_000_000_000:
            ts //= 1000
        return dt.datetime.utcfromtimestamp(ts).date().isoformat()
    return s[:10]


def scorecard_id(summary: dict):
    return pick(summary, "id", "scorecardId", "scorecardInternalId", "scoreCardId")


# ============================================================
#  Per-hole stats uit een Garmin scorekaart-detail
# ============================================================
FAIRWAY_MAP = {
    "HIT": "hit", "FAIRWAY": "hit",
    "LEFT": "left", "MISSED_LEFT": "left",
    "RIGHT": "right", "MISSED_RIGHT": "right",
    "SHORT": "miss", "LONG": "miss", "MISSED": "miss", "MISS": "miss",
}


def detail_holes(detail) -> list[dict]:
    if isinstance(detail, dict):
        sd = detail.get("scorecardDetails")
        if isinstance(sd, list) and sd:
            holes = sd[0].get("scorecard", {}).get("holes")
            if isinstance(holes, list):
                return holes
    return []


def parse_hole(h: dict) -> dict:
    number = pick(h, "number", "holeNumber", "hole")
    putts = pick(h, "putts", "puttCount", "numberOfPutts")
    penalties = pick(h, "penalties", "penaltyStrokes", "penaltyCount")
    fairway_raw = pick(h, "fairwayShotOutcome", "fairwayShot", "fairway", "teeShotOutcome")
    fairway = FAIRWAY_MAP.get(str(fairway_raw).upper()) if fairway_raw is not None else None
    strokes = pick(h, "strokes", "shots", "stroke")
    par = pick(h, "par", "holePar")
    return {
        "hole": to_int(number),
        "par": to_int(par),
        "score": to_int(strokes),
        "putts": to_int(putts),
        "penalties": to_int(penalties),
        "fairway": fairway,
        "gir": None,
    }


def to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ============================================================
#  Supabase: credentials ophalen + rondes bijwerken
# ============================================================
def sb_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def sb_get_user_credentials() -> list[dict]:
    resp = request_with_retry(
        "GET",
        f"{SUPABASE_URL}/functions/v1/get-garmin-creds",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}"},
        timeout=30,
    )
    return resp.json()


def sb_get_rounds(user_id: str) -> list[dict]:
    r = request_with_retry(
        "GET",
        f"{SUPABASE_URL}/rest/v1/rounds?select=id,date,holes,holes_data,deleted_at&user_id=eq.{user_id}",
        headers=sb_headers(),
    )
    return r.json()


def sb_create_round(round_data: dict) -> None:
    request_with_retry(
        "POST", f"{SUPABASE_URL}/rest/v1/rounds",
        headers={**sb_headers(), "Prefer": "return=minimal"},
        data=json.dumps(round_data),
        timeout=30,
    )


def sb_patch_round(round_id: str, patch: dict) -> None:
    request_with_retry(
        "PATCH", f"{SUPABASE_URL}/rest/v1/rounds?id=eq.{round_id}",
        headers={**sb_headers(), "Prefer": "return=minimal"},
        data=json.dumps(patch),
    )


def sb_save_garmin_token(user_id: str, token_str: str) -> None:
    """Slaat een vernieuwd Garmin-sessietoken op via de Edge Function (die versleutelt)."""
    request_with_retry(
        "POST",
        f"{SUPABASE_URL}/functions/v1/save-garmin-token",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
        data=json.dumps({"user_id": user_id, "token": token_str}),
        timeout=30,
    )


def course_name_from_garmin(summary: dict, detail: dict | None = None) -> str | None:
    """Probeert de baannaam te achterhalen uit Garmin-data."""
    name = pick(summary, "courseName", "name", "golfCourse")
    if name and isinstance(name, str):
        return name
    if detail and isinstance(detail, dict):
        sd = detail.get("scorecardDetails")
        if isinstance(sd, list) and sd:
            sc = sd[0].get("scorecard", {})
            name = pick(sc, "courseName", "name")
            if name and isinstance(name, str):
                return name
            course = sc.get("course") or sc.get("golfCourse") or {}
            if isinstance(course, dict):
                name = pick(course, "name", "courseName")
                if name:
                    return str(name)
    return None


def build_nq_round(summary: dict, detail: dict, garmin_holes: list[dict],
                   user_id: str, date: str) -> dict:
    """Maakt een NQ-ronde-record op basis van Garmin-data."""
    holes_data = []
    total_score = 0
    for h in garmin_holes:
        score = h.get("score")
        if score is not None:
            total_score += score
        hd = {k: h.get(k) for k in ("hole", "par", "score", "putts", "penalties", "fairway")}
        hd["gir"] = None
        p, sc, pu = hd.get("par"), hd.get("score"), hd.get("putts")
        if p is not None and sc is not None and pu is not None:
            hd["gir"] = (sc - pu) <= (p - 2)
        holes_data.append(hd)

    return {
        "user_id": user_id,
        "date": date,
        "course": course_name_from_garmin(summary, detail) or "",
        "holes": len(garmin_holes),
        "score": total_score if total_score > 0 else None,
        "holes_data": holes_data,
        "non_qualifying": True,
    }


def merge_into_holes(existing: list, garmin_holes: list[dict]) -> list:
    by_num = {g["hole"]: g for g in garmin_holes if g.get("hole") is not None}
    existing = existing or []

    if not existing:
        existing = [{"hole": g["hole"], "par": None, "score": None,
                     "fairway": None, "gir": None, "putts": None, "penalties": None}
                    for g in garmin_holes if g.get("hole") is not None]

    out = []
    for h in existing:
        g = by_num.get(h.get("hole"))
        merged = dict(h)
        if g:
            if g.get("putts") is not None:
                merged["putts"] = g["putts"]
            if g.get("penalties") is not None:
                merged["penalties"] = g["penalties"]
            if g.get("fairway") is not None and h.get("par") != 3:
                merged["fairway"] = g["fairway"]
            par, score, putts = h.get("par"), h.get("score"), g.get("putts")
            if par is not None and score is not None and putts is not None:
                merged["gir"] = (score - putts) <= (par - 2)
        out.append(merged)
    return out


def sync_user(user_id: str, g: Garmin) -> tuple[int, int]:
    """Synct Garmin-rondes voor één gebruiker. Geeft (updated, failed) terug."""
    summaries = as_list(retry_call(g.get_golf_summary, limit=200))
    log.info("  %d Garmin-scorekaart(en) gevonden.", len(summaries))

    rounds = sb_get_rounds(user_id)
    by_date: dict[str, list] = {}
    for r in rounds:
        by_date.setdefault(r["date"], []).append(r)
    log.info("  %d ronde(s) in Supabase.", len(rounds))

    updated, failed = 0, 0
    for s in summaries:
        date = scorecard_date(s)
        candidates = by_date.get(date or "", [])

        try:
            detail = retry_call(g.get_golf_scorecard, scorecard_id(s))
            garmin_holes = [parse_hole(h) for h in detail_holes(detail)]
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("  Scorekaart %s (%s) overgeslagen: %s", scorecard_id(s), date, e)
            continue

        # Splits in actief (niet soft-deleted) en alle kandidaten.
        active_candidates = [c for c in candidates if not c.get("deleted_at")]

        if not candidates:
            # Geen ronde in Supabase voor deze datum → maak NQ-ronde aan.
            if not garmin_holes:
                log.debug("  %s: geen hole-data, NQ-ronde overgeslagen.", date)
                continue
            try:
                nq = build_nq_round(s, detail, garmin_holes, user_id, date)
                sb_create_round(nq)
                by_date.setdefault(date, []).append({"date": date, "holes": nq["holes"]})
                updated += 1
                log.info("  ✓ %s: NQ-ronde aangemaakt (%d holes, baan: %s)",
                         date, nq["holes"], nq.get("course") or "onbekend")
            except Exception as e:  # noqa: BLE001
                failed += 1
                log.warning("  NQ-ronde aanmaken mislukt voor %s: %s", date, e)
            continue

        if not active_candidates:
            # Alleen soft-deleted rondes → gebruiker heeft ze bewust verwijderd; overslaan.
            log.debug("  %s: alleen soft-deleted ronde(s) aanwezig; overgeslagen.", date)
            continue

        if not any(h.get("putts") is not None or h.get("fairway") or h.get("penalties") is not None
                   for h in garmin_holes):
            continue

        target = active_candidates[0]
        if len(active_candidates) > 1:
            target = next((c for c in active_candidates if c.get("holes") == len(garmin_holes)), active_candidates[0])

        try:
            merged = merge_into_holes(target.get("holes_data"), garmin_holes)
            sb_patch_round(target["id"], {"holes_data": merged})
            updated += 1
            log.info("  ✓ %s: shot-stats toegevoegd (%d holes)", date, len(garmin_holes))
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("  Bijwerken van ronde %s (%s) mislukt: %s", target.get("id"), date, e)

    return updated, failed


# ============================================================
#  main
# ============================================================
def main() -> None:
    dump = "--dump" in sys.argv

    if dump:
        # Lokale debug: gebruik GARMIN_EMAIL/GARMIN_PASSWORD direct.
        email = os.environ.get("GARMIN_EMAIL") or require_env("GARMIN_EMAIL")
        password = os.environ.get("GARMIN_PASSWORD") or require_env("GARMIN_PASSWORD")
        log.info("Dump-modus: inloggen als %s…", email)
        g = garmin_login(email, password)
        summaries = as_list(retry_call(g.get_golf_summary, limit=200))
        print("\n=== RUWE SUMMARY (eerste scorekaart) ===")
        print(json.dumps(summaries[0] if summaries else {}, indent=2, ensure_ascii=False)[:4000])
        if summaries:
            sid = scorecard_id(summaries[0])
            print(f"\n(scorecard_id = {sid})")
            print("\n=== GEPARSEDE HOLES ===")
            holes = [parse_hole(h) for h in detail_holes(retry_call(g.get_golf_scorecard, sid))]
            print(json.dumps(holes, indent=2, ensure_ascii=False))
        return

    require_env("SUPABASE_URL")
    if not SUPABASE_KEY:
        log.error("Geen Supabase-key: zet SUPABASE_SERVICE_KEY.")
        sys.exit(2)

    users = sb_get_user_credentials()

    # Als handmatig getriggerd voor één gebruiker (knop in de app), filter hierop.
    if GOLF_USER_ID := os.environ.get("GOLF_USER_ID", ""):
        users = [u for u in users if u["user_id"] == GOLF_USER_ID]

    if not users:
        log.info("Geen Garmin-credentials gevonden in Supabase. Niets te doen.")
        return

    log.info("%d gebruiker(s) met Garmin-credentials.", len(users))

    total_updated, total_failed = 0, 0
    for user in users:
        user_id = user["user_id"]
        username = user["garmin_username"]
        stored_token = user.get("garmin_token")
        log.info("Verwerken gebruiker %s (%s)…", user_id, username)

        g = None

        # Probeer eerst het opgeslagen sessie-token (geen OTP nodig).
        if stored_token:
            try:
                g = garmin_login_token(stored_token)
                log.info("  Ingelogd via opgeslagen token.")
            except Exception as e:  # noqa: BLE001
                log.warning("  Opgeslagen token werkte niet (%s); probeer wachtwoord.", e)

        # Fallback: email + wachtwoord (mislukt als Garmin OTP vereist).
        if g is None:
            password = user.get("garmin_password")
            if not password:
                log.error("  Geen token én geen wachtwoord voor %s. Draai garmin_login.py.", username)
                total_failed += 1
                continue
            try:
                g = garmin_login_password(username, password)
                log.info("  Ingelogd via wachtwoord.")
            except Exception as e:  # noqa: BLE001
                log.error(
                    "  Login mislukt voor %s: %s\n"
                    "  → Draai 'python scripts/garmin_login.py' lokaal om een nieuw token op te slaan.",
                    username, e,
                )
                total_failed += 1
                continue

        try:
            updated, failed = sync_user(user_id, g)
            total_updated += updated
            total_failed += failed
        except Exception as e:  # noqa: BLE001
            log.error("  Sync mislukt voor %s: %s", user_id, e)
            total_failed += 1
            continue

        # Vernieuw het token na een succesvolle sync.
        try:
            try:
                new_token = g.garth.dumps()
            except AttributeError:
                new_token = g.client.dumps()
            sb_save_garmin_token(user_id, new_token)
            log.debug("  Token vernieuwd in Supabase.")
        except Exception as e:  # noqa: BLE001
            log.warning("  Token vernieuwen mislukt (niet kritiek): %s", e)

    log.info("Klaar. %d ronde(s) bijgewerkt, %d overgeslagen door fouten.",
             total_updated, total_failed)
    if total_updated == 0 and total_failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_main(main)
