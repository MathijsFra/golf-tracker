#!/usr/bin/env python3
"""
Sync Toptracer -> Supabase.

Haalt per gebruiker club-afstanden op via de Toptracer GraphQL-API
en schrijft ze naar de tabel `toptracer_clubs`.

Auth: opgeslagen email + wachtwoord; automatische headless login via Playwright.
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

from golfutil import setup_logging, require_env, request_with_retry, run_main

log = setup_logging("toptracer")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
GOLF_USER_ID = os.environ.get("GOLF_USER_ID", "")

TOPTRACER_AUTH_URL = (
    "https://login.toptracer.com/realms/toptracer/protocol/openid-connect/auth"
)
TOPTRACER_TOKEN_URL = (
    "https://login.toptracer.com/realms/toptracer/protocol/openid-connect/token"
)
TOPTRACER_GRAPHQL_URL = "https://api.toptracer.com/api/appsbff/graphql"
TOPTRACER_CLIENT_ID = "trca"
TOPTRACER_REDIRECT_URI = "com.toptracer.community.dev:/callback"

CLUBS_QUERY = """
query GetUserClubs {
  userClubs {
    clubs {
      id
      clubType
      clubTypeDisplayName
      category
      isHidden
      averages {
        carry
        total
      }
    }
  }
}
"""


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
    """Haalt alle accounts met ontsleutelde Toptracer-credentials op."""
    resp = request_with_retry(
        "GET",
        f"{SUPABASE_URL}/functions/v1/get-toptracer-creds",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}"},
        timeout=30,
    )
    return resp.json()


def sb_save_token(user_id: str, token: str) -> None:
    """Slaat een vernieuwd refresh-token versleuteld op."""
    request_with_retry(
        "POST",
        f"{SUPABASE_URL}/functions/v1/save-toptracer-token",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
        data=json.dumps({"user_id": user_id, "token": token}),
        timeout=30,
    )


def sb_set_status(user_id: str, status: str, error: str | None = None) -> None:
    """Schrijft auth_status en optionele foutmelding terug naar Supabase."""
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
    except Exception as e:  # noqa: BLE001
        log.warning("  Status bijwerken mislukt: %s", e)


def sb_upsert_clubs(user_id: str, clubs: list[dict]) -> int:
    """Schrijft club-afstanden weg naar toptracer_clubs (upsert op user_id + club_type)."""
    if not clubs:
        return 0
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

    if not rows:
        return 0

    request_with_retry(
        "POST",
        f"{SUPABASE_URL}/rest/v1/toptracer_clubs",
        headers={
            **sb_headers(),
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        data=json.dumps(rows),
        timeout=30,
    )
    return len(rows)


# ============================================================
#  Toptracer auth helpers
# ============================================================
def _pkce_pair() -> tuple[str, str]:
    """Genereert een PKCE code_verifier + code_challenge paar."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    return verifier, challenge


def exchange_code(code: str, verifier: str) -> tuple[str, str]:
    """Wisselt een auth-code + verifier in voor (access_token, refresh_token)."""
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
    access_token = data.get("access_token")
    refresh_token = data.get("refresh_token", "")
    if not access_token:
        raise RuntimeError(f"Token-uitwisseling mislukt: {data}")
    return access_token, refresh_token


def refresh_access_token(refresh_token: str) -> tuple[str, str]:
    """Wisselt refresh-token in voor een nieuw access-token + refresh-token."""
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
    new_refresh = data.get("refresh_token", refresh_token)
    if not access_token:
        raise RuntimeError(f"Geen access_token in respons: {data}")
    return access_token, new_refresh


def headless_login(email: str, password: str) -> tuple[str, str]:
    """
    Logt headless in bij Toptracer via Playwright + PKCE.

    Onderschept de 302-redirect van Keycloak op responsniveau,
    zodat we de auth-code uit de Location-header kunnen lezen
    voordat de browser probeert de custom URI-scheme te openen.
    """
    from playwright.sync_api import sync_playwright  # type: ignore[import]

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

    captured_code: list[str] = []

    def on_response(response) -> None:  # noqa: ANN001
        if response.status in (301, 302, 303, 307, 308):
            location = response.headers.get("location", "")
            if location.startswith(TOPTRACER_REDIRECT_URI):
                qs = parse_qs(urlparse(location).query)
                code = (qs.get("code") or [None])[0]
                if code:
                    captured_code.append(code)

    log.debug("  Headless login starten voor %s…", email)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("response", on_response)

        page.goto(auth_url, wait_until="networkidle", timeout=20_000)
        page.wait_for_selector("input#username", timeout=10_000)
        page.fill("input#username", email)
        page.fill("input#password", password)

        try:
            page.click("input#kc-login", timeout=5_000)
            page.wait_for_timeout(3_000)
        except Exception:  # noqa: BLE001
            pass  # custom-scheme navigatie gooit een fout; code is al onderschept

        browser.close()

    if not captured_code:
        raise RuntimeError(
            "Geen auth-code ontvangen. Controleer je Toptracer-e-mail en wachtwoord."
        )

    log.debug("  Auth-code ontvangen, tokens ophalen…")
    return exchange_code(captured_code[0], verifier)


def graphql(query: str, access_token: str) -> dict:
    resp = request_with_retry(
        "POST",
        TOPTRACER_GRAPHQL_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        data=json.dumps({"query": query}),
        timeout=30,
    )
    return resp.json()


# ============================================================
#  Sync per gebruiker
# ============================================================
def sync_one_user(user: dict) -> int:
    user_id = user["user_id"]
    username = user.get("toptracer_username", user_id)
    refresh_token: str | None = user.get("toptracer_token")
    email: str | None = user.get("toptracer_email")
    password: str | None = user.get("toptracer_password")

    log.info("Verwerken %s (%s)…", user_id, username)

    access_token: str | None = None
    new_refresh = refresh_token

    # Stap 1: probeer bestaand refresh-token
    if refresh_token:
        try:
            access_token, new_refresh = refresh_access_token(refresh_token)
            log.debug("  Refresh-token geldig.")
        except Exception as e:  # noqa: BLE001
            log.warning("  Refresh-token verlopen (%s). Headless login proberen…", e)

    # Stap 2: headless login als fallback
    if not access_token:
        if not email or not password:
            raise RuntimeError("Geen credentials beschikbaar voor headless login.")
        access_token, new_refresh = headless_login(email, password)

    # Vernieuwd refresh-token opslaan
    if new_refresh and new_refresh != refresh_token:
        try:
            sb_save_token(user_id, new_refresh)
            log.debug("  Refresh-token opgeslagen.")
        except Exception as e:  # noqa: BLE001
            log.warning("  Token opslaan mislukt (niet kritiek): %s", e)

    # Club-afstanden ophalen
    result = graphql(CLUBS_QUERY, access_token)
    if "errors" in result:
        raise RuntimeError(f"GraphQL-fout: {result['errors']}")

    clubs = (result.get("data") or {}).get("userClubs", {}).get("clubs") or []
    log.info("  %d club(s) ontvangen van Toptracer.", len(clubs))

    saved = sb_upsert_clubs(user_id, clubs)
    log.info("  %d club(s) opgeslagen.", saved)
    sb_set_status(user_id, "completed")
    return saved


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
    total, failed = 0, 0
    for u in users:
        try:
            total += sync_one_user(u)
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.error("Sync mislukt voor %s: %s", u["user_id"], e)
            sb_set_status(u["user_id"], "failed", str(e))

    log.info("Klaar. %d club(s) bijgewerkt, %d gebruiker(s) mislukt.", total, failed)
    if failed and total == 0:
        sys.exit(1)


if __name__ == "__main__":
    run_main(main)
