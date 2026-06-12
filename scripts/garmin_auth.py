#!/usr/bin/env python3
"""
Server-side Garmin Connect koppeling via Supabase OTP-brug.

Wordt getriggerd door een GitHub Actions workflow voor één specifieke gebruiker.
Logt in bij Garmin Connect. Als Garmin een OTP stuurt, schrijft dit script
de status 'otp_needed' naar Supabase en wacht tot de gebruiker de code
invult in de app. Vervolgens wordt het login afgerond en het sessietoken opgeslagen.

Vereiste environment variables:
  SUPABASE_URL, SUPABASE_SERVICE_KEY, GOLF_USER_ID
"""

import builtins
import json
import os
import sys
import time

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
GOLF_USER_ID = os.environ.get("GOLF_USER_ID", "")

OTP_POLL_INTERVAL = 5   # seconden
OTP_TIMEOUT = 300       # 5 minuten max wachten op de gebruiker


def sb_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def set_status(status: str, error: str = None, clear_otp: bool = False) -> None:
    patch = {"garmin_auth_status": status}
    if error is not None:
        patch["garmin_auth_error"] = error[:500]
    if clear_otp:
        patch["garmin_auth_otp"] = None
    requests.patch(
        f"{SUPABASE_URL}/rest/v1/user_settings?user_id=eq.{GOLF_USER_ID}",
        headers={**sb_headers(), "Prefer": "return=minimal"},
        json=patch,
        timeout=15,
    )


def poll_for_otp() -> str:
    """Wacht tot de gebruiker de OTP invult via de app (max 5 minuten)."""
    print("Wachten op OTP van gebruiker via app…", flush=True)
    start = time.time()
    while time.time() - start < OTP_TIMEOUT:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/user_settings"
            f"?user_id=eq.{GOLF_USER_ID}&select=garmin_auth_otp",
            headers=sb_headers(),
            timeout=15,
        )
        data = r.json()
        if data and data[0].get("garmin_auth_otp"):
            otp = data[0]["garmin_auth_otp"].strip()
            print("OTP ontvangen.", flush=True)
            return otp
        time.sleep(OTP_POLL_INTERVAL)
    raise TimeoutError("OTP niet ontvangen binnen 5 minuten.")


def get_garmin_creds() -> tuple[str, str]:
    """Haalt Garmin-credentials op voor GOLF_USER_ID."""
    r = requests.get(
        f"{SUPABASE_URL}/functions/v1/get-garmin-creds",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}"},
        timeout=30,
    )
    if not r.ok:
        raise RuntimeError(f"get-garmin-creds mislukt: {r.status_code} {r.text}")
    users = r.json()
    for u in users:
        if u["user_id"] == GOLF_USER_ID:
            return u["garmin_username"], u.get("garmin_password", "")
    raise ValueError(f"Geen Garmin-credentials gevonden voor gebruiker {GOLF_USER_ID}.")


def save_token(token_str: str) -> None:
    r = requests.post(
        f"{SUPABASE_URL}/functions/v1/save-garmin-token",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
        json={"user_id": GOLF_USER_ID, "token": token_str},
        timeout=30,
    )
    if not r.ok:
        raise RuntimeError(f"Token opslaan mislukt: {r.status_code} {r.text}")


def main() -> None:
    for var in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "GOLF_USER_ID"):
        if not os.environ.get(var):
            print(f"Fout: omgevingsvariabele {var} ontbreekt.", file=sys.stderr)
            sys.exit(2)

    print(f"Garmin-koppeling starten voor gebruiker {GOLF_USER_ID}…", flush=True)
    set_status("pending", error=None, clear_otp=True)

    try:
        username, password = get_garmin_creds()
    except Exception as e:
        print(f"Fout: {e}", file=sys.stderr)
        set_status("failed", error=str(e))
        sys.exit(1)

    if not password:
        msg = "Geen wachtwoord opgeslagen. Vul je Garmin-wachtwoord in via de app."
        print(f"Fout: {msg}", file=sys.stderr)
        set_status("failed", error=msg)
        sys.exit(1)

    # MFA-callback die de OTP-code ophaalt via Supabase (de app stuurt hem in).
    def prompt_mfa() -> str:
        print("Garmin vraagt om verificatiecode (MFA).", flush=True)
        set_status("otp_needed")
        try:
            otp = poll_for_otp()
            set_status("pending", clear_otp=True)
            return otp
        except TimeoutError as exc:
            set_status("failed", error="Timeout: geen verificatiecode ingevoerd binnen 5 minuten.")
            raise SystemExit(1) from exc

    # Patch builtins.input als vangnet voor varianten die input() aanroepen.
    original_input = builtins.input
    builtins.input = prompt_mfa

    try:
        import inspect
        import importlib.metadata
        from garminconnect import Garmin

        try:
            gc_version = importlib.metadata.version("garminconnect")
        except Exception:
            gc_version = "onbekend"
        print(f"garminconnect versie: {gc_version}", flush=True)
        print(f"Inloggen op Garmin Connect als {username}…", flush=True)

        # Bepaal welke API beschikbaar is via introspectie.
        init_params = inspect.signature(Garmin.__init__).parameters

        if "prompt_mfa" in init_params:
            # garminconnect >=0.2.x: prompt_mfa hoort in de constructor.
            print("API: prompt_mfa via constructor.", flush=True)
            g = Garmin(email=username, password=password, prompt_mfa=prompt_mfa)
        else:
            print("API: prompt_mfa niet in constructor, val terug op builtins.input.", flush=True)
            g = Garmin(email=username, password=password)

        login_params = inspect.signature(g.login).parameters
        if "pin_func" in login_params:
            g.login(pin_func=prompt_mfa)
        elif "prompt_mfa" in login_params:
            g.login(prompt_mfa=prompt_mfa)
        else:
            g.login()  # builtins.input-patch als vangnet

    except SystemExit:
        raise
    except Exception as e:
        print(f"Garmin login mislukt: {e}", file=sys.stderr)
        set_status("failed", error=str(e))
        sys.exit(1)
    finally:
        builtins.input = original_input

    try:
        # garth-gebaseerd (>=0.2.x): g.garth.dumps(); oudere versie: g.client.dumps()
        try:
            token_str = g.garth.dumps()
        except AttributeError:
            token_str = g.client.dumps()
        save_token(token_str)
        set_status("completed")
        print("✓ Garmin-token opgeslagen. Koppeling geslaagd.", flush=True)
    except Exception as e:
        print(f"Token opslaan mislukt: {e}", file=sys.stderr)
        set_status("failed", error=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
