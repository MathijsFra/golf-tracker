#!/usr/bin/env python3
"""
Eenmalig interactief inloggen op Garmin Connect.

Garmin stuurt bij een nieuwe login een verificatiecode per e-mail (OTP).
Dit script handelt die code interactief af en slaat het sessie-token
versleuteld op in Supabase. De dagelijkse sync hergebruikt dat token
zodat er geen OTP meer nodig is.

Gebruik (éénmalig per account):
    python scripts/garmin_login.py

Vereiste environment variables (of interactief invullen):
    SUPABASE_URL          - bijv. https://xxxx.supabase.co
    SUPABASE_SERVICE_KEY  - service-role key (zie Supabase dashboard)
    GOLF_USER_ID          - jouw auth-user-ID (zie Supabase > Authentication > Users)
    GARMIN_EMAIL          - je Garmin-account e-mailadres
    GARMIN_PASSWORD       - je Garmin-wachtwoord
"""

import os
import sys
import getpass
import requests
from garminconnect import Garmin

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
GOLF_USER_ID = os.environ.get("GOLF_USER_ID", "")
GARMIN_EMAIL = os.environ.get("GARMIN_EMAIL", "")
GARMIN_PASSWORD = os.environ.get("GARMIN_PASSWORD", "")


def prompt(label: str, secret: bool = False) -> str:
    fn = getpass.getpass if secret else input
    val = fn(f"{label}: ").strip()
    if not val:
        print(f"Fout: {label} mag niet leeg zijn.")
        sys.exit(1)
    return val


def main() -> None:
    global SUPABASE_URL, SUPABASE_KEY, GOLF_USER_ID, GARMIN_EMAIL, GARMIN_PASSWORD

    if not SUPABASE_URL:
        SUPABASE_URL = prompt("Supabase URL")
    if not SUPABASE_KEY:
        SUPABASE_KEY = prompt("Supabase service key", secret=True)
    if not GOLF_USER_ID:
        GOLF_USER_ID = prompt("Jouw Supabase user-ID (Supabase > Authentication > Users)")
    if not GARMIN_EMAIL:
        GARMIN_EMAIL = prompt("Garmin e-mailadres")
    if not GARMIN_PASSWORD:
        GARMIN_PASSWORD = prompt("Garmin wachtwoord", secret=True)

    print(f"\nInloggen op Garmin Connect als {GARMIN_EMAIL}…")
    print("Als je een verificatiecode per e-mail ontvangt, vul die dan in als het script erom vraagt.\n")

    g = Garmin(email=GARMIN_EMAIL, password=GARMIN_PASSWORD)
    g.login()  # garminconnect vraagt zelf om de OTP als die vereist is

    print("\n✓ Ingelogd bij Garmin!")

    # Serialiseer de sessie naar een token-string.
    token_str = g.client.dumps()

    # Sla het token versleuteld op via de Edge Function.
    print("Token opslaan in Supabase…")
    r = requests.post(
        f"{SUPABASE_URL}/functions/v1/save-garmin-token",
        headers={
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
        },
        json={"user_id": GOLF_USER_ID, "token": token_str},
        timeout=30,
    )
    if r.ok:
        print("✓ Token opgeslagen. De dagelijkse Garmin-sync kan nu draaien zonder OTP.")
    else:
        print(f"✗ Opslaan mislukt ({r.status_code}): {r.text}")
        sys.exit(1)

    # Sla ook het e-mailadres op zodat de app weet welk account gekoppeld is.
    r2 = requests.patch(
        f"{SUPABASE_URL}/rest/v1/user_settings?user_id=eq.{GOLF_USER_ID}",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        json={"garmin_username": GARMIN_EMAIL},
        timeout=30,
    )
    if not r2.ok:
        print(f"(Waarschuwing: e-mailadres opslaan mislukt: {r2.status_code})")

    print(f"\nGereed. Account: {GARMIN_EMAIL} | User: {GOLF_USER_ID}")
    print("Het token wordt na elke succesvolle sync automatisch vernieuwd.")
    print("Draai dit script opnieuw als de sync meldt dat het token verlopen is.")


if __name__ == "__main__":
    main()
