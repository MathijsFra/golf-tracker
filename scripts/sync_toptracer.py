#!/usr/bin/env python3
"""
Sync Toptracer -> Supabase.

Haalt per gebruiker op:
  - Club-afstanden (userClubs per gameMode)
  - Game-sessies met per-slag statistieken
  - Lifetime stats (totaal slagen, longest shot, topsnelheden)

Auth: opgeslagen email + wachtwoord; automatische HTTP-login via Keycloak.
Vereiste environment variables:
  SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import base64
import hashlib
import os
import secrets
import sys
import json
import datetime as dt
from urllib.parse import urlencode, urlparse, parse_qs

import requests as _requests
from bs4 import BeautifulSoup
from golfutil import setup_logging, require_env, request_with_retry, run_main

log = setup_logging("toptracer")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
GOLF_USER_ID = os.environ.get("GOLF_USER_ID", "")

TOPTRACER_AUTH_URL  = "https://login.toptracer.com/realms/toptracer/protocol/openid-connect/auth"
TOPTRACER_TOKEN_URL = "https://login.toptracer.com/realms/toptracer/protocol/openid-connect/token"
TOPTRACER_GRAPHQL_URL = "https://api.toptracer.com/api/appsbff/graphql"
TOPTRACER_CLIENT_ID   = "trca"
TOPTRACER_REDIRECT_URI = "com.toptracer.community.dev:/callback"

# Game-modi waarvoor we club-afstanden ophalen
CLUB_GAME_MODES = ["LaunchMonitor", "WhatsInMyBag", "DrivingChallenge"]

# Game-modi waarvoor we sessies ophalen (alle relevante modi)
SESSION_GAME_MODES = [
    "LaunchMonitor", "WhatsInMyBag", "Assessment", "AssessmentLite",
    "DrivingChallenge", "VirtualGolf", "PrecisionSeries", "PrecisionPro",
    "SwingCapture",
]

SESSION_LIMIT = 100  # max sessies per gameMode per sync

# ============================================================
#  GraphQL queries
# ============================================================
_CLUBS_FRAGMENT = """
    clubs {
      id clubType clubTypeDisplayName category isHidden
      averages { carry total }
    }
"""

CLUBS_QUERY = f"""
query GetUserClubs {{
  lm:   userClubs(gameMode: LaunchMonitor)    {{ {_CLUBS_FRAGMENT} }}
  wimb: userClubs(gameMode: WhatsInMyBag)     {{ {_CLUBS_FRAGMENT} }}
  dr:   userClubs(gameMode: DrivingChallenge) {{ {_CLUBS_FRAGMENT} }}
}}
"""

STATS_QUERY = """
query GetGameStats {
  gameStats {
    rangesVisited
    rangeVisits
    totalDurationMinutes
    totalShots
    longestShot
    topBallSpeed
    topClubSpeed
  }
}
"""

SESSIONS_QUERY = """
query GetSessions($gameMode: GameMode!, $offset: Int) {
  gameSessionsByGameMode(gameMode: $gameMode, offset: $offset, limit: %d) {
    gameSessions {
      id gameMode score tracedShots isFinished
      beginTimestamp timestamp hasLaunchMonitorStats
      range { name city countryCode }
      virtualGolf { courseId holeSet teeId par score }
      t30 {
        score
        hcp { overall driving approaches }
        strokesGained { overall driving approaches }
      }
      t12 {
        averageDistanceTee averageFromPinApproaches
        targetsHit within15Approaches longestShotTee
      }
      drivingChallenge { score }
      shots {
        id shotIndex isHidden clubType
        stats {
          carry total ballSpeed launchAngle landingAngle
          curve height offTargetLine
        }
        launchMonitorStats { spinRate clubHeadSpeed smashFactor }
        t30 { strokesGained distanceToPin }
      }
    }
  }
}
""" % SESSION_LIMIT


# ============================================================
#  Supabase helpers
# ============================================================
def sb_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def sb_get_credentials() -> list[dict]:
    resp = request_with_retry(
        "GET",
        f"{SUPABASE_URL}/functions/v1/get-toptracer-creds",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}"},
        timeout=30,
    )
    return resp.json()


def sb_save_token(user_id: str, token: str) -> None:
    request_with_retry(
        "POST",
        f"{SUPABASE_URL}/functions/v1/save-toptracer-token",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
        data=json.dumps({"user_id": user_id, "token": token}),
        timeout=30,
    )


def sb_set_status(user_id: str, status: str, error: str | None = None) -> None:
    fields: dict = {"toptracer_auth_status": status}
    if error is not None:
        fields["toptracer_auth_error"] = error
    try:
        request_with_retry(
            "PATCH",
            f"{SUPABASE_URL}/rest/v1/user_settings?user_id=eq.{user_id}",
            headers={**sb_headers(), "Prefer": "return=minimal"},
            data=json.dumps(fields),
            timeout=10,
        )
    except Exception as e:
        log.warning("  Status bijwerken mislukt: %s", e)


def sb_upsert(table: str, rows: list[dict]) -> None:
    if not rows:
        return
    request_with_retry(
        "POST",
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**sb_headers(), "Prefer": "resolution=merge-duplicates,return=minimal"},
        data=json.dumps(rows),
        timeout=60,
    )


def sb_upsert_clubs(user_id: str, clubs: list[dict]) -> int:
    rows = []
    for c in clubs:
        if c.get("isHidden"):
            continue
        avg = c.get("averages") or {}
        rows.append({
            "user_id": user_id,
            "club_type": c["clubType"],
            "club_display_name": c.get("clubTypeDisplayName"),
            "avg_carry_m": avg.get("carry"),
            "avg_total_m": avg.get("total"),
            "updated_at": dt.datetime.utcnow().isoformat() + "Z",
        })
    if rows:
        sb_upsert("toptracer_clubs", rows)
    return len(rows)


def sb_upsert_stats(user_id: str, stats: dict) -> None:
    gs = stats.get("gameStats") or {}
    row = {
        "user_id": user_id,
        "ranges_visited":     gs.get("rangesVisited"),
        "range_visits":       gs.get("rangeVisits"),
        "total_duration_min": gs.get("totalDurationMinutes"),
        "total_shots":        gs.get("totalShots"),
        "longest_shot_m":     gs.get("longestShot"),
        "top_ball_speed":     gs.get("topBallSpeed"),
        "top_club_speed":     gs.get("topClubSpeed"),
        "updated_at":         dt.datetime.utcnow().isoformat() + "Z",
    }
    sb_upsert("toptracer_stats", [row])


def _session_row(user_id: str, s: dict) -> dict:
    rng = s.get("range") or {}
    t30 = s.get("t30") or {}
    t30hcp = t30.get("hcp") or {}
    t30sg  = t30.get("strokesGained") or {}
    t12 = s.get("t12") or {}
    vg  = s.get("virtualGolf") or {}
    return {
        "user_id":       user_id,
        "toptracer_id":  s["id"],
        "game_mode":     s.get("gameMode"),
        "range_name":    rng.get("name"),
        "range_city":    rng.get("city"),
        "range_country": rng.get("countryCode"),
        "score":         s.get("score"),
        "traced_shots":  s.get("tracedShots"),
        "is_finished":   s.get("isFinished"),
        "began_at":      s.get("beginTimestamp"),
        "ended_at":      s.get("timestamp"),
        "has_lm_stats":  s.get("hasLaunchMonitorStats"),
        # T30
        "t30_score":           t30.get("score"),
        "t30_hcp_overall":     t30hcp.get("overall"),
        "t30_hcp_driving":     t30hcp.get("driving"),
        "t30_hcp_approaches":  t30hcp.get("approaches"),
        "t30_sg_overall":      t30sg.get("overall"),
        "t30_sg_driving":      t30sg.get("driving"),
        "t30_sg_approaches":   t30sg.get("approaches"),
        # T12
        "t12_avg_dist_tee":  t12.get("averageDistanceTee"),
        "t12_avg_from_pin":  t12.get("averageFromPinApproaches"),
        "t12_targets_hit":   t12.get("targetsHit"),
        "t12_within_15":     t12.get("within15Approaches"),
        "t12_longest_tee":   t12.get("longestShotTee"),
        # Virtual Golf
        "vg_course_id": vg.get("courseId"),
        "vg_hole_set":  vg.get("holeSet"),
        "vg_par":       vg.get("par"),
        # Raw (alles voor toekomstig gebruik)
        "raw_data": {k: v for k, v in s.items() if k != "shots"},
        "synced_at": dt.datetime.utcnow().isoformat() + "Z",
    }


def _shot_rows(user_id: str, session_db_id: str | None, s: dict) -> list[dict]:
    rows = []
    for shot in s.get("shots") or []:
        stats = shot.get("stats") or {}
        lm    = shot.get("launchMonitorStats") or {}
        t30   = shot.get("t30") or {}
        rows.append({
            "user_id":           user_id,
            "session_id":        session_db_id,
            "toptracer_shot_id": shot["id"],
            "shot_index":        shot.get("shotIndex"),
            "game_mode":         shot.get("gameMode") or s.get("gameMode"),
            "club_type":         shot.get("clubType"),
            "is_hidden":         shot.get("isHidden"),
            # Stats
            "carry_m":          stats.get("carry"),
            "total_m":          stats.get("total"),
            "ball_speed":       stats.get("ballSpeed"),
            "launch_angle":     stats.get("launchAngle"),
            "landing_angle":    stats.get("landingAngle"),
            "curve":            stats.get("curve"),
            "height_m":         stats.get("height"),
            "off_target_line":  stats.get("offTargetLine"),
            # Launch monitor
            "spin_rate":        lm.get("spinRate"),
            "club_speed":       lm.get("clubHeadSpeed"),
            "smash_factor":     lm.get("smashFactor"),
            # T30
            "strokes_gained":   t30.get("strokesGained"),
            "distance_to_pin":  t30.get("distanceToPin"),
            "raw_data":         shot,
        })
    return rows


def sb_upsert_sessions(user_id: str, sessions: list[dict]) -> tuple[int, int]:
    """Sla sessies op en hun slagen. Geeft (sessie_count, slag_count) terug."""
    if not sessions:
        return 0, 0

    session_rows = [_session_row(user_id, s) for s in sessions]
    sb_upsert("toptracer_sessions", session_rows)

    # Sessie-DB-IDs ophalen voor de foreign key in shots
    toptracer_ids = [s["id"] for s in sessions]
    id_list = ",".join(f'"{tid}"' for tid in toptracer_ids)
    resp = request_with_retry(
        "GET",
        f"{SUPABASE_URL}/rest/v1/toptracer_sessions?user_id=eq.{user_id}&toptracer_id=in.({id_list})&select=id,toptracer_id",
        headers=sb_headers(),
        timeout=30,
    )
    id_map = {r["toptracer_id"]: r["id"] for r in resp.json()}

    all_shots: list[dict] = []
    for s in sessions:
        db_id = id_map.get(s["id"])
        all_shots.extend(_shot_rows(user_id, db_id, s))

    # Slagen in batches van 200
    for i in range(0, len(all_shots), 200):
        sb_upsert("toptracer_shots", all_shots[i:i + 200])

    return len(session_rows), len(all_shots)


# ============================================================
#  Toptracer auth helpers
# ============================================================
def _pkce_pair() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    return verifier, challenge


def exchange_code(code: str, verifier: str) -> tuple[str, str]:
    resp = request_with_retry(
        "POST",
        TOPTRACER_TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=urlencode({
            "grant_type": "authorization_code",
            "client_id": TOPTRACER_CLIENT_ID,
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": TOPTRACER_REDIRECT_URI,
        }),
        timeout=30,
    )
    data = resp.json()
    access_token  = data.get("access_token")
    refresh_token = data.get("refresh_token", "")
    if not access_token:
        raise RuntimeError(f"Token-uitwisseling mislukt: {data}")
    return access_token, refresh_token


def refresh_access_token(refresh_token: str) -> tuple[str, str]:
    resp = request_with_retry(
        "POST",
        TOPTRACER_TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=urlencode({
            "grant_type": "refresh_token",
            "client_id": TOPTRACER_CLIENT_ID,
            "refresh_token": refresh_token,
        }),
        timeout=30,
    )
    data = resp.json()
    access_token = data.get("access_token")
    new_refresh  = data.get("refresh_token", refresh_token)
    if not access_token:
        raise RuntimeError(f"Geen access_token in respons: {data}")
    return access_token, new_refresh


def http_login(email: str, password: str) -> tuple[str, str]:
    """
    Logt in bij Toptracer via directe HTTP-requests.
    Keycloak gebruikt een tweestaps-flow: username → wachtwoord.
    De 302-redirect naar de custom URI bevat de auth-code in de Location-header.
    """
    verifier, challenge = _pkce_pair()
    auth_url = TOPTRACER_AUTH_URL + "?" + urlencode({
        "client_id": TOPTRACER_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": TOPTRACER_REDIRECT_URI,
        "scope": "openid",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": secrets.token_hex(8),
    })

    session = _requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/109.0 Firefox/119.0"

    log.debug("  HTTP-login starten voor %s…", email)
    r1 = session.get(auth_url, timeout=15)
    r1.raise_for_status()

    soup = BeautifulSoup(r1.text, "html.parser")
    form = soup.find("form", id="kc-form-login") or soup.find("form")
    if not form or not form.get("action"):
        raise RuntimeError("Geen login-formulier gevonden op de Toptracer-inlogpagina.")
    action_url = str(form["action"])

    r2 = session.post(
        action_url,
        data={"username": email, "credentialId": "", "login": "Log In"},
        allow_redirects=False,
        timeout=15,
    )

    if r2.status_code == 200:
        soup2 = BeautifulSoup(r2.text, "html.parser")
        form2 = soup2.find("form")
        if not form2 or not form2.get("action"):
            raise RuntimeError("Geen wachtwoord-formulier gevonden na username-stap.")
        action2 = str(form2["action"])
        r3 = session.post(
            action2,
            data={"username": email, "password": password, "credentialId": "", "login": "Log In"},
            allow_redirects=False,
            timeout=15,
        )
        location = r3.headers.get("location", "")
    else:
        location = r2.headers.get("location", "")

    if location and not location.startswith(TOPTRACER_REDIRECT_URI):
        r_extra = session.get(location, allow_redirects=False, timeout=15)
        location = r_extra.headers.get("location", "")

    if not location.startswith(TOPTRACER_REDIRECT_URI):
        raise RuntimeError(
            "Login mislukt. Controleer je Toptracer-e-mail en wachtwoord."
            + (f" (redirect: {location[:80]})" if location else "")
        )

    qs = parse_qs(urlparse(location).query)
    code = (qs.get("code") or [None])[0]
    if not code:
        raise RuntimeError(f"Geen auth-code in redirect: {location}")

    log.debug("  Auth-code ontvangen, tokens ophalen…")
    return exchange_code(code, verifier)


def gql(query: str, variables: dict, access_token: str) -> dict:
    resp = request_with_retry(
        "POST",
        TOPTRACER_GRAPHQL_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        data=json.dumps({"query": query, "variables": variables}),
        timeout=30,
    )
    result = resp.json()
    if "errors" in result:
        raise RuntimeError(f"GraphQL-fout: {result['errors']}")
    return result.get("data") or {}


# ============================================================
#  Sync per gebruiker
# ============================================================
def sync_one_user(user: dict) -> dict:
    user_id  = user["user_id"]
    username = user.get("toptracer_username", user_id)
    refresh_token = user.get("toptracer_token")
    email    = user.get("toptracer_email")
    password = user.get("toptracer_password")

    log.info("Verwerken %s (%s)…", user_id, username)

    access_token: str | None = None
    new_refresh = refresh_token

    if refresh_token:
        try:
            access_token, new_refresh = refresh_access_token(refresh_token)
            log.debug("  Refresh-token geldig.")
        except Exception as e:
            log.warning("  Refresh-token verlopen (%s). Headless login proberen…", e)

    if not access_token:
        if not email or not password:
            raise RuntimeError("Geen credentials beschikbaar voor login.")
        access_token, new_refresh = http_login(email, password)

    if new_refresh and new_refresh != refresh_token:
        try:
            sb_save_token(user_id, new_refresh)
            log.debug("  Refresh-token opgeslagen.")
        except Exception as e:
            log.warning("  Token opslaan mislukt (niet kritiek): %s", e)

    totals = {"clubs": 0, "sessions": 0, "shots": 0}

    # --- Club-afstanden ---
    club_data = gql(CLUBS_QUERY, {}, access_token)
    merged_clubs: dict[str, dict] = {}
    for alias in ("lm", "wimb", "dr"):
        for club in (club_data.get(alias) or {}).get("clubs") or []:
            ct = club.get("clubType")
            if not ct:
                continue
            avg_new = (club.get("averages") or {}).get("carry")
            avg_old = (merged_clubs.get(ct, {}).get("averages") or {}).get("carry")
            if ct not in merged_clubs or (avg_new and not avg_old):
                merged_clubs[ct] = club
    clubs = list(merged_clubs.values())
    totals["clubs"] = sb_upsert_clubs(user_id, clubs)
    log.info("  %d club(s) opgeslagen.", totals["clubs"])

    # --- Lifetime stats ---
    try:
        stats_data = gql(STATS_QUERY, {}, access_token)
        sb_upsert_stats(user_id, stats_data)
        log.info("  Lifetime stats opgeslagen.")
    except Exception as e:
        log.warning("  Stats ophalen mislukt (niet kritiek): %s", e)

    # --- Sessies per gameMode ---
    for mode in SESSION_GAME_MODES:
        try:
            result = gql(SESSIONS_QUERY, {"gameMode": mode, "offset": 0}, access_token)
            sessions = (result.get("gameSessionsByGameMode") or {}).get("gameSessions") or []
            if not sessions:
                continue
            s_count, sh_count = sb_upsert_sessions(user_id, sessions)
            totals["sessions"] += s_count
            totals["shots"] += sh_count
            log.info("  %s: %d sessie(s), %d slag(en).", mode, s_count, sh_count)
        except Exception as e:
            log.warning("  Sessies voor %s mislukt (niet kritiek): %s", mode, e)

    sb_set_status(user_id, "completed")
    return totals


# ============================================================
#  main
# ============================================================
def main() -> None:
    require_env("SUPABASE_URL")
    if not SUPABASE_KEY:
        log.error("Geen Supabase-key: zet SUPABASE_SERVICE_KEY.")
        sys.exit(2)

    users = sb_get_credentials()

    if GOLF_USER_ID and users:
        users = [u for u in users if u["user_id"] == GOLF_USER_ID]

    if not users:
        log.info("Geen gebruikers met Toptracer-credentials. Koppel Toptracer via de app.")
        return

    log.info("%d gebruiker(s) te synchroniseren.", len(users))
    total_clubs = total_sessions = total_shots = failed = 0

    for u in users:
        try:
            t = sync_one_user(u)
            total_clubs    += t["clubs"]
            total_sessions += t["sessions"]
            total_shots    += t["shots"]
        except Exception as e:
            failed += 1
            log.error("Sync mislukt voor %s: %s", u["user_id"], e)
            sb_set_status(u["user_id"], "failed", str(e))

    log.info(
        "Klaar. %d club(s), %d sessie(s), %d slag(en) bijgewerkt; %d gebruiker(s) mislukt.",
        total_clubs, total_sessions, total_shots, failed,
    )
    if failed and total_clubs == 0 and total_sessions == 0:
        sys.exit(1)


if __name__ == "__main__":
    run_main(main)
