#!/usr/bin/env python3
"""
Sync GOLF.NL -> Supabase.

Logt in op de GOLF.NL-backend, haalt je scores op (overzicht + per-hole
scorekaart) en schrijft nieuwe rondes naar de Supabase-tabel `rounds`.
Bedoeld om gepland te draaien via .github/workflows/sync-golfnl.yml (of lokaal).

Vereiste environment variables:
  GOLFNL_USERNAME, GOLFNL_PASSWORD   - je GOLF.NL-login
  SUPABASE_URL, SUPABASE_ANON_KEY    - uit js/config.js
Optioneel: LOG_LEVEL=DEBUG voor uitgebreidere logging.

Dry-run (parse een opgeslagen HTML-bestand, geen login/Supabase):
  python sync_golfnl.py scores-data.html
"""

import os
import sys
import re
import json
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse

from golfutil import setup_logging, require_env, request_with_retry, run_main

log = setup_logging("golfnl")

# ------------------------------------------------------------
#  GOLF.NL is een server-gerenderde ASP.NET-site (geen JSON-API).
#  Login = formulier-POST met anti-forgery token + sessie-cookie.
#  Deze constanten nog bevestigen met de Payload-tab van POST /login
#  en je scores-pagina (zie docs/golfnl-sync.md).
# ------------------------------------------------------------
LOGIN_URL = "https://mijn.golf.nl/login"
# De scores-pagina laadt de lijst via een AJAX-partial. Dit is dat endpoint
# (scorecardid=MA== -> base64 "0" -> de volledige lijst).
SCORES_PAGE = "https://mijn.golf.nl/mijn-spel/scores"
SCORES_URL = "https://mijn.golf.nl/mijn-spel/Scores/ScoresDetails?scorecardid=MA%3d%3d"
# Detailpagina per scorekaart (server-gerenderd). {id} = de id uit de lijst.
SCORE_DETAIL_URL = "https://mijn.golf.nl/mijn-spel/scores/scorekaart-bekijken?scorecardid={id}"
# Per nieuwe ronde de scorekaart ophalen voor par/score-per-hole + holes-telling.
FETCH_DETAILS = True
TOKEN_FIELD = "__RequestVerificationToken"    # Sitecore anti-forgery token (uit verborgen veld)
FIELD_USERNAME = "email"                      # GOLF.NL gebruikt 'email' als gebruikersnaam
FIELD_PASSWORD = "password"
EXTRA_FIELDS = {"scController": "Login", "scAction": "LoginValidate"}  # Sitecore route-velden

GOLFNL_USERNAME = os.environ.get("GOLFNL_USERNAME", "")
GOLFNL_PASSWORD = os.environ.get("GOLFNL_PASSWORD", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
# Server-side schrijven gaat met de service_role-key (omzeilt RLS).
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
# Aan welk account (auth user-id) de rondes gekoppeld worden.
GOLF_USER_ID = os.environ.get("GOLF_USER_ID", "")

# Browser-achtige user agent helpt soms tegen simpele bot-checks.
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

# Nederlandse maanden -> maandnummer (voor datums als "22 mei 2026").
NL_MONTHS = {
    "jan": 1, "januari": 1, "feb": 2, "februari": 2, "mrt": 3, "maart": 3,
    "apr": 4, "april": 4, "mei": 5, "jun": 6, "juni": 6,
    "jul": 7, "juli": 7, "aug": 8, "augustus": 8, "sep": 9, "sept": 9, "september": 9,
    "okt": 10, "oktober": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}


# ============================================================
#  STAP 1 — Inloggen op GOLF.NL  (formulier + anti-forgery token)
# ============================================================
def golfnl_login(session: requests.Session) -> None:
    """
    Logt in via het loginformulier. Auth zit daarna in de sessie-cookie
    (geen bearer-token). Gooit een fout als het inloggen mislukt.
    """
    # 1. Loginpagina ophalen -> cookies + verborgen anti-forgery token.
    r = request_with_retry("GET", LOGIN_URL, session=session)
    soup = BeautifulSoup(r.text, "html.parser")
    token_el = soup.select_one(f'input[name="{TOKEN_FIELD}"]')
    token = token_el["value"] if token_el and token_el.has_attr("value") else None
    if not token:
        log.warning("Geen anti-forgery token gevonden op de loginpagina "
                    "(layout gewijzigd of Accept-header probleem?); probeer toch in te loggen.")
    else:
        log.debug("Anti-forgery token gevonden.")

    # 2. Formulier posten (urlencoded). Cookies gaan automatisch mee via session.
    data = {FIELD_USERNAME: GOLFNL_USERNAME, FIELD_PASSWORD: GOLFNL_PASSWORD, **EXTRA_FIELDS}
    if token:
        data[TOKEN_FIELD] = token
    r2 = request_with_retry(
        "POST", LOGIN_URL, session=session, data=data,
        headers={"Referer": LOGIN_URL, "Origin": "https://mijn.golf.nl"},
    )

    # 3. Controle of we echt ingelogd zijn.
    # Gebruik urlparse zodat query strings (?returnUrl=...) niet de check omzeilen.
    final_path = urlparse(r2.url).path.rstrip("/")
    if final_path == "/login" or final_path.endswith("/login"):
        raise RuntimeError(
            "Inloggen mislukt (teruggestuurd naar /login). "
            "Controleer GOLFNL_USERNAME/GOLFNL_PASSWORD (en of er geen 2FA aanstaat)."
        )
    log.info("Ingelogd op GOLF.NL (eindpagina: %s).", r2.url)


# ============================================================
#  STAP 2 — Scores-partial ophalen en uitlezen (HTML scrapen)
# ============================================================
# Rondes met >= deze totaal-slagen tellen we als 18 holes, anders 9.
# (GOLF.NL toont het aantal holes niet in het overzicht; dit is een
#  veilige drempel voor jouw data — 9h ~41-58, 18h ~94-121 slagen.)
HOLES_THRESHOLD = 70


def golfnl_fetch_scores(session: requests.Session) -> list[dict]:
    """Haalt de scores op. Probeert eerst de AJAX-partial; valt terug op de
    volledige scores-pagina (die wél correct auth-cookies accepteert)."""
    # Stap 1: probeer het AJAX-endpoint.
    try:
        r = request_with_retry("GET", SCORES_URL, session=session, headers={
            "X-Requested-With": "XMLHttpRequest",
            "Referer": SCORES_PAGE,
        })
        rounds = parse_scores_html(r.text)
        if rounds:
            log.debug("Scores opgehaald via AJAX-endpoint (%d rondes).", len(rounds))
            return rounds
        log.debug("AJAX-endpoint gaf lege lijst; val terug op volledige pagina.")
    except Exception as e:
        log.debug("AJAX-endpoint mislukt (%s); val terug op volledige pagina.", e)

    # Stap 2: volledige scores-pagina (server-side HTML, werkt altijd als de
    # sessie geldig is).
    r = request_with_retry("GET", SCORES_PAGE, session=session,
                           headers={"Referer": "https://mijn.golf.nl/dashboard"})
    log.debug("Scores-pagina: finale URL=%s, status=%s, grootte=%d bytes.",
              r.url, r.status_code, len(r.text))
    log.debug("Scores-HTML eerste 300 tekens: %s", r.text[:300].replace("\n", " "))
    rounds = parse_scores_html(r.text)
    if not rounds:
        log.warning("Geen rondes gevonden in de scores-HTML "
                    "(layout gewijzigd of sessie verlopen?). "
                    "Finale URL was: %s", r.url)
    return rounds


def parse_scores_html(html: str) -> list[dict]:
    """Zet de GOLF.NL scores-HTML om naar rijen voor onze `rounds`-tabel."""
    soup = BeautifulSoup(html, "html.parser")
    rounds = []
    for label in soup.select("label.js-scorecard-toggle"):
        sub = label.select_one(".c-linkBlock__subtitle")
        title = label.select_one(".c-linkBlock__title")
        if not sub or not title:
            continue

        details = {}
        for c in label.select(".c-score__details__content"):
            lab = c.select_one(".c-score__details__label")
            txt = c.select_one(".c-score__details__text")
            if lab and txt:
                details[lab.get_text(strip=True)] = txt.get_text(" ", strip=True)

        log.debug("Score-details labels: %s", list(details.keys()))

        total = to_int(details.get("Totaal aantal slagen"))
        is_qualifying = details.get("Qualifying") == "Ja"
        rounds.append({
            "_scorecardid": label.get("id"),   # intern: voor de detail-/scorekaartpagina
            "date": iso_date(sub.get_text(strip=True)),
            "course": title.get_text(strip=True),
            "holes": 18 if (total or 0) >= HOLES_THRESHOLD else 9,
            "tee": details.get("Tee"),
            "stb": to_int(details.get("Stableford")),
            "sd": to_float(details.get("Dagresultaat (SD)")),
            "hcp": first_float(details.get("Handicap")),
            "score": total,
            "course_handicap": to_int(details.get("Baanhandicap")),
            "holes_data": [],
            "screenshots": [],
            "notes": None if is_qualifying else "Non-qualifying",
            "non_qualifying": not is_qualifying,
        })
    return rounds


def to_int(v):
    if v is None:
        return None
    m = re.search(r"-?\d+", str(v))
    return int(m.group()) if m else None


def to_float(v):
    if v is None:
        return None
    m = re.search(r"-?\d+(?:[.,]\d+)?", str(v))
    return float(m.group().replace(",", ".")) if m else None


def parse_extra_strokes(cell_text: str):
    """Extract '+N' handicap strokes from a par cell like '4+2' → 2, '3' → None."""
    m = re.search(r'\+(\d+)', str(cell_text))
    return int(m.group(1)) if m else None


def first_float(v):
    """Eerste kommagetal uit een tekst (bv. '34.2 4.0' -> 34.2)."""
    return to_float(v)


# ---- Scorekaart-detailpagina (per-hole par + score) -------------------
def golfnl_fetch_scorecard(session: requests.Session, scorecard_id: str) -> dict:
    """Haalt één scorekaart-detailpagina op en parseert de holes."""
    url = SCORE_DETAIL_URL.format(id=scorecard_id)
    r = request_with_retry("GET", url, session=session, headers={"Referer": SCORES_PAGE})
    return parse_scorecard_html(r.text)


def parse_scorecard_html(html: str) -> dict:
    """Leest de Hole/Par/Slagen/Stableford-tabel van de scorekaart-detailpagina.
    Kolomvolgorde: holes | par (met slagindex in <sup>) | slagen (geen class) | stableford.
    GOLF.NL toont geen fairway/GIR/putts; die blijven None."""
    soup = BeautifulSoup(html, "html.parser")
    holes_data = []
    for tr in soup.select(".c-scorecard tbody tr"):
        hole_cell = tr.select_one(".c-scorecard__scores__holes")
        hole = to_int(hole_cell.get_text()) if hole_cell else None
        if hole is None:          # slaat de "Totaal"-rij over
            continue
        tds = tr.find_all("td")
        par_cell = tr.select_one(".c-scorecard__scores__par")
        # Score heeft geen class — het is de 3e <td> (index 2).
        score_cell = tds[2] if len(tds) >= 3 else None
        stb_cell = tr.select_one(".c-scorecard__scores__stableford")
        par_text = par_cell.get_text() if par_cell else ""
        holes_data.append({
            "hole": hole,
            # to_int() pakt het eerste getal en negeert de <sup>-slagindex vanzelf.
            "par": to_int(par_text),
            "extra_strokes": parse_extra_strokes(par_text),
            "score": to_int(score_cell.get_text()) if score_cell else None,
            "stb": to_int(stb_cell.get_text()) if stb_cell else None,
            "fairway": None, "gir": None, "putts": None, "penalties": None,
        })

    # Probeer course rating + slope uit de rest van de pagina te halen.
    # Golf.nl toont deze voor de handicap-differentiaal-berekening.
    cr_slope = extract_cr_slope_from_html(soup)

    return {"holes": len(holes_data), "holes_data": holes_data, **cr_slope}


def extract_cr_slope_from_html(soup) -> dict:
    """Zoekt course rating en slope rating in de scorekaart-HTML.
    Logt alle gevonden label-waarde-paren in DEBUG zodat we nieuwe velden kunnen ontdekken."""
    result = {}

    # Strategie 1: dezelfde label-structuur als de scores-lijst
    details = {}
    for c in soup.select(".c-score__details__content"):
        lab = c.select_one(".c-score__details__label")
        txt = c.select_one(".c-score__details__text")
        if lab and txt:
            details[lab.get_text(strip=True)] = txt.get_text(" ", strip=True)

    if details:
        log.debug("Scorekaart detail-labels: %s", details)

    # Bekende NL labels voor course rating en slope
    cr_labels    = ["Course Rating", "CR", "Courserating", "Course rating"]
    slope_labels = ["Slope Rating", "Slope", "Sloperating", "Slope rating"]

    for label in cr_labels:
        if label in details:
            result["course_rating"] = to_float(details[label])
            break
    for label in slope_labels:
        if label in details:
            result["slope_rating"] = to_int(details[label])
            break

    # Strategie 2: vrije tekst-scan op typische CR/slope-patronen
    if "course_rating" not in result or "slope_rating" not in result:
        text = soup.get_text(" ")
        if "course_rating" not in result:
            m = re.search(r"(?:Course\s*Rating|CR)[^\d]*(\d{2,3}[.,]\d)", text, re.IGNORECASE)
            if m:
                result["course_rating"] = to_float(m.group(1))
        if "slope_rating" not in result:
            m = re.search(r"Slope(?:\s*Rating)?[^\d]*(\d{2,3})\b", text, re.IGNORECASE)
            if m:
                val = int(m.group(1))
                if 55 <= val <= 155:   # geldig slope-bereik per WHS
                    result["slope_rating"] = val

    return result


def iso_date(v) -> str | None:
    """Probeert allerlei datumvormen naar yyyy-mm-dd te zetten."""
    if not v:
        return None
    v = str(v).strip()
    if len(v) >= 10 and v[4] == "-" and v[7] == "-":   # al ISO (evt met tijd)
        return v[:10]
    parts = v.replace(",", "").split()                  # "22 mei 2026 15:10" of "24 oktober 2025"
    if len(parts) >= 3:
        mon = NL_MONTHS.get(parts[1].lower())
        if mon:
            try:
                return f"{int(parts[2]):04d}-{mon:02d}-{int(parts[0]):02d}"
            except (ValueError, IndexError):
                pass
    return None


# ============================================================
#  STAP 4 — Wegschrijven naar Supabase (werkt al volledig)
# ============================================================
def supabase_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def derive_par(holes_data: list[dict]) -> int | None:
    """Berekent de totale par vanuit per-hole data."""
    pars = [h.get("par") for h in holes_data if h.get("par") is not None]
    return sum(pars) if pars else None


def upsert_course_tee(
    club_name: str,
    tee_name: str | None,
    holes: int,
    loop_name: str = "",
    par: int | None = None,
    course_rating: float | None = None,
    slope_rating: int | None = None,
) -> tuple[str | None, str | None]:
    """
    Upsert club → course (lus) → tee in Supabase. Geeft (course_id, course_tee_id) terug.
    Schrijft geen None-waarden over bestaande data heen.
    loop_name = de specifieke lus/baan (bijv. "Aak/Jol"); "" = onbekend.
    """
    if not club_name:
        return None, None
    try:
        # 1. Club upserten op (name, country)
        club_row = {"name": club_name, "country": "NL", "updated_at": "now()"}
        resp = request_with_retry(
            "POST",
            f"{SUPABASE_URL}/rest/v1/clubs?on_conflict=name,country",
            headers={**supabase_headers(),
                     "Prefer": "resolution=merge-duplicates,return=representation"},
            data=json.dumps(club_row),
            timeout=15,
        )
        rows = resp.json()
        if not rows or not isinstance(rows, list):
            log.debug("Club upsert gaf geen rij terug: %s", resp.text[:100])
            return None, None
        club_id = rows[0]["id"]

        # 2. Course (lus) upserten op (club_id, loop_name)
        course_row = {
            "club_id":   club_id,
            "loop_name": loop_name,
            "name":      club_name,   # achterwaartse compatibiliteit; veld wordt later verwijderd
            "country":   "NL",
            "updated_at": "now()",
        }
        resp2 = request_with_retry(
            "POST",
            f"{SUPABASE_URL}/rest/v1/courses?on_conflict=club_id,loop_name",
            headers={**supabase_headers(),
                     "Prefer": "resolution=merge-duplicates,return=representation"},
            data=json.dumps(course_row),
            timeout=15,
        )
        rows2 = resp2.json()
        if not rows2 or not isinstance(rows2, list):
            log.debug("Course upsert gaf geen rij terug: %s", resp2.text[:100])
            return None, None
        course_id = rows2[0]["id"]

        # 3. Tee upserten als we een tee-naam hebben
        if not tee_name:
            return course_id, None

        tee_row: dict = {
            "course_id":  course_id,
            "tee_name":   tee_name,
            "tee_gender": "unspecified",
            "holes":      holes,
        }
        if par is not None:
            tee_row["par"] = par
        if course_rating is not None:
            tee_row["course_rating"] = course_rating
        if slope_rating is not None:
            tee_row["slope_rating"] = slope_rating

        resp3 = request_with_retry(
            "POST",
            f"{SUPABASE_URL}/rest/v1/course_tees?on_conflict=course_id,tee_name,tee_gender,holes",
            headers={**supabase_headers(),
                     "Prefer": "resolution=merge-duplicates,return=representation"},
            data=json.dumps(tee_row),
            timeout=15,
        )
        tee_rows = resp3.json()
        course_tee_id = tee_rows[0]["id"] if tee_rows and isinstance(tee_rows, list) else None
        return course_id, course_tee_id

    except Exception as e:  # noqa: BLE001
        log.debug("Club/course/tee upsert mislukt (niet kritiek): %s", e)
        return None, None


def sb_get_user_settings() -> list[dict]:
    """Haalt alle accounts met ontsleutelde GOLF.NL-credentials op via de Edge Function.
    De Edge Function doet de AES-256-GCM-decryptie server-side; het sync-script
    heeft geen eigen encryptiesleutel nodig."""
    resp = request_with_retry(
        "GET",
        f"{SUPABASE_URL}/functions/v1/get-golfnl-creds",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}"},
        timeout=30,
    )
    return resp.json()


def existing_rounds(user_id: str) -> list[dict]:
    """Haalt bestaande rondes van dit account op (inclusief soft-deleted)."""
    resp = request_with_retry(
        "GET",
        f"{SUPABASE_URL}/rest/v1/rounds"
        f"?select=id,date,holes,sd,holes_data,golfnl_scorecard_id,deleted_at&user_id=eq.{user_id}",
        headers=supabase_headers(),
    )
    return resp.json()


def round_key(r: dict):
    sd = r.get("sd")
    sd = round(float(sd), 1) if sd is not None else None
    return (r.get("date"), r.get("holes"), sd)


def push_to_supabase(new_rounds: list[dict], user_id: str) -> int:
    if not new_rounds:
        log.info("Niets nieuws om toe te voegen.")
        return 0

    added, failed = 0, 0
    for rd in new_rounds:
        row = {**{k: v for k, v in rd.items() if not k.startswith("_")}, "user_id": user_id}
        if rd.get("_scorecardid"):
            row["golfnl_scorecard_id"] = rd["_scorecardid"]
        if rd.get("_course_id"):
            row["course_id"] = rd["_course_id"]
        if rd.get("_course_tee_id"):
            row["course_tee_id"] = rd["_course_tee_id"]
        try:
            request_with_retry(
                "POST", f"{SUPABASE_URL}/rest/v1/rounds",
                headers={**supabase_headers(), "Prefer": "return=minimal"},
                data=json.dumps(row), timeout=30,
            )
            added += 1
            log.debug("Ronde %s (%s, %dh) toegevoegd.", rd.get("date"), rd.get("course"), rd.get("holes", 0))
        except Exception as e:  # noqa: BLE001
            failed += 1
            body = getattr(getattr(e, "response", None), "text", "")
            log.warning("Ronde %s (%s) niet toegevoegd: %s %s", rd.get("date"), rd.get("course"), e, body)

    if added:
        log.info("%d nieuwe ronde(s) toegevoegd.", added)
    if failed:
        log.warning("%d ronde(s) konden niet worden toegevoegd.", failed)
    return added


# ============================================================
#  main
# ============================================================
def dry_run(path: str) -> None:
    """Parse een lokaal opgeslagen HTML-bestand (scores-lijst óf scorekaart)
    en print het resultaat, zonder login of Supabase:
        python sync_golfnl.py scores-data.html
        python sync_golfnl.py scorekaart.html
    """
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()
    if "c-scorecard__scores" in html:          # detail-scorekaart
        result = parse_scorecard_html(html)
    else:                                       # scores-lijst
        result = parse_scores_html(html)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def derive_double_bogeys(holes_data: list[dict]) -> int | None:
    """Telt holes waar score - par >= 2 (double bogey of slechter)."""
    count = 0
    for h in holes_data:
        p, s = h.get("par"), h.get("score")
        if p is not None and s is not None:
            if s - p >= 2:
                count += 1
    return count if holes_data else None


def sb_set_golfnl_status(user_id: str, status: str) -> None:
    """Zet golfnl_sync_status voor een gebruiker (bijv. 'completed')."""
    try:
        request_with_retry(
            "PATCH",
            f"{SUPABASE_URL}/rest/v1/user_settings?user_id=eq.{user_id}",
            headers={**supabase_headers(), "Prefer": "return=minimal"},
            data=json.dumps({"golfnl_sync_status": status}),
            timeout=15,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("golfnl_sync_status bijwerken mislukt (niet kritiek): %s", e)


def update_round_in_supabase(sb_id: str, fields: dict) -> None:
    """Werkt een bestaande ronde in Supabase bij via PATCH op id."""
    request_with_retry(
        "PATCH",
        f"{SUPABASE_URL}/rest/v1/rounds?id=eq.{sb_id}",
        headers={**supabase_headers(), "Prefer": "return=minimal"},
        data=json.dumps(fields),
        timeout=30,
    )


def sync_one_user(username: str, password: str, user_id: str) -> int:
    """Synct één gebruiker. Geeft het aantal toegevoegde rondes terug."""
    global GOLFNL_USERNAME, GOLFNL_PASSWORD
    GOLFNL_USERNAME = username
    GOLFNL_PASSWORD = password

    session = requests.Session()
    session.headers.update({"User-Agent": UA})

    log.info("Inloggen op GOLF.NL voor gebruiker %s…", user_id)
    golfnl_login(session)

    rounds = golfnl_fetch_scores(session)
    log.info("%d score(s) opgehaald van GOLF.NL.", len(rounds))

    # Haal scorekaart-details op voor ALLE rondes (nieuwe én bestaande).
    # Zo hebben we altijd actuele per-hole data, ongeacht wat er al in Supabase staat.
    failed_scorecards = 0
    if FETCH_DETAILS:
        for rd in rounds:
            if not rd.get("_scorecardid"):
                continue
            try:
                d = golfnl_fetch_scorecard(session, rd["_scorecardid"])
                if d["holes_data"]:
                    rd["holes"] = d["holes"]
                    rd["holes_data"] = d["holes_data"]
                    rd["double_bogeys"] = derive_double_bogeys(d["holes_data"])
                    log.debug("Scorekaart opgehaald: %s (%d holes).", rd.get("date"), rd["holes"])
                # Koppel course rating + slope als gevonden in de HTML
                if d.get("course_rating") is not None:
                    rd["_course_rating"] = d["course_rating"]
                if d.get("slope_rating") is not None:
                    rd["_slope_rating"] = d["slope_rating"]
                log.debug(
                    "CR/slope uit scorekaart: CR=%s Slope=%s",
                    d.get("course_rating"), d.get("slope_rating"),
                )
            except Exception as e:  # noqa: BLE001
                failed_scorecards += 1
                log.warning("Scorekaart %s overgeslagen: %s", rd.get("_scorecardid"), e)
        if failed_scorecards:
            log.warning("%d scorekaart(en) konden niet worden opgehaald.", failed_scorecards)

    # Vergelijk met Supabase: nieuw vs. bestaand.
    # Primaire match: golfnl_scorecard_id. Fallback: (date, holes, sd) voor bestaande rondes.
    db_rounds = existing_rounds(user_id)
    have_by_scorecard = {r["golfnl_scorecard_id"]: r["id"]
                         for r in db_rounds if r.get("golfnl_scorecard_id")}
    have_by_key = {round_key(r): r["id"] for r in db_rounds}
    by_id = {r["id"]: r for r in db_rounds}
    log.debug("Supabase heeft %d ronde(s) voor deze gebruiker.", len(db_rounds))

    def find_sb_id(rd: dict) -> str | None:
        """Geeft het Supabase-ID van een GOLF.NL-ronde, of None als hij nieuw is."""
        sid = rd.get("_scorecardid")
        if sid and sid in have_by_scorecard:
            return have_by_scorecard[sid]
        return have_by_key.get(round_key(rd))

    new_rounds = [r for r in rounds if r.get("date") and find_sb_id(r) is None]
    existing_golfnl = [r for r in rounds if r.get("date") and find_sb_id(r) is not None]
    log.info("%d nieuwe ronde(s), %d bestaande ronde(s) te updaten.", len(new_rounds), len(existing_golfnl))

    # Upsert course + tee voor alle rondes en sla de IDs op.
    # Zo bouwen we automatisch een baandatabase op vanuit gespeelde rondes.
    for rd in rounds:
        par = derive_par(rd.get("holes_data") or [])
        course_id, course_tee_id = upsert_course_tee(
            club_name=rd.get("course", ""),
            loop_name="",   # TODO: loop_name extraheren uit golf.nl HTML
            tee_name=rd.get("tee"),
            holes=rd.get("holes", 18),
            par=par,
            course_rating=rd.get("_course_rating"),
            slope_rating=rd.get("_slope_rating"),
        )
        rd["_course_id"] = course_id
        rd["_course_tee_id"] = course_tee_id
    courses_linked = sum(1 for r in rounds if r.get("_course_tee_id"))
    log.info("%d ronde(s) gekoppeld aan een baan+tee.", courses_linked)

    # Update bestaande rondes met alle beschikbare GOLF.NL-data.
    # Overschrijft score/course_handicap/holes_data/double_bogeys — raakt Garmin-velden niet aan.
    updated = 0
    update_failed = 0
    for rd in existing_golfnl:
        sb_id = find_sb_id(rd)
        sb_round = by_id.get(sb_id, {})
        # Soft-deleted rondes niet aanraken — de gebruiker heeft ze bewust verwijderd.
        if sb_round.get("deleted_at"):
            continue
        fields: dict = {}
        # Basisvelden uit de scorelijst
        for f in ("score", "course_handicap", "notes"):
            if rd.get(f) is not None:
                fields[f] = rd[f]
        # non_qualifying altijd meenemen (boolean, ook False is een waarde)
        if rd.get("non_qualifying") is not None:
            fields["non_qualifying"] = rd["non_qualifying"]
        # Per-hole data (alleen als gevuld)
        if rd.get("holes_data"):
            fields["holes"] = rd["holes"]
            fields["holes_data"] = rd["holes_data"]
        if rd.get("double_bogeys") is not None:
            fields["double_bogeys"] = rd["double_bogeys"]
        # Sla scorecard-ID op als die er nog niet was (migratie van bestaande rondes)
        if rd.get("_scorecardid") and not sb_round.get("golfnl_scorecard_id"):
            fields["golfnl_scorecard_id"] = rd["_scorecardid"]
        if rd.get("_course_id"):
            fields["course_id"] = rd["_course_id"]
        if rd.get("_course_tee_id"):
            fields["course_tee_id"] = rd["_course_tee_id"]
        if not fields:
            continue
        try:
            update_round_in_supabase(sb_id, fields)
            updated += 1
            log.debug("Ronde %s bijgewerkt (id=%s, velden=%s).", rd.get("date"), sb_id, list(fields))
        except Exception as e:  # noqa: BLE001
            update_failed += 1
            log.warning("Update mislukt voor ronde %s: %s", rd.get("date"), e)

    if updated:
        log.info("%d bestaande ronde(s) bijgewerkt met GOLF.NL-data.", updated)
    if update_failed:
        log.warning("%d ronde-update(s) mislukt.", update_failed)

    return push_to_supabase(new_rounds, user_id)


def main() -> None:
    if len(sys.argv) > 1:
        dry_run(sys.argv[1])
        return

    require_env("SUPABASE_URL")
    if not SUPABASE_KEY:
        log.error("Geen Supabase-key: zet SUPABASE_SERVICE_KEY (aanrader) of SUPABASE_ANON_KEY.")
        sys.exit(2)

    # Credentials per gebruiker uit Supabase (ingesteld via de app).
    users = sb_get_user_settings()

    # Als handmatig getriggerd voor één gebruiker (knop in de app), filter hierop.
    if GOLF_USER_ID and users:
        users = [u for u in users if u["user_id"] == GOLF_USER_ID]

    # Fallback: env vars voor achterwaartse compatibiliteit / lokaal testen.
    if not users and GOLFNL_USERNAME and GOLFNL_PASSWORD and GOLF_USER_ID:
        log.info("Geen user_settings gevonden; val terug op GOLFNL_USERNAME/GOLF_USER_ID env vars.")
        users = [{"user_id": GOLF_USER_ID, "golfnl_username": GOLFNL_USERNAME,
                  "golfnl_password": GOLFNL_PASSWORD}]

    if not users:
        log.error("Geen gebruikers met GOLF.NL-credentials. "
                  "Stel ze in via de app → Synchroniseren → GOLF.NL inloggegevens.")
        sys.exit(2)

    log.info("%d gebruiker(s) te synchroniseren.", len(users))
    total_added, failed_users = 0, 0
    for u in users:
        user_id = u["user_id"]
        try:
            total_added += sync_one_user(
                u["golfnl_username"], u["golfnl_password"], user_id,
            )
            sb_set_golfnl_status(user_id, "completed")
        except Exception as e:  # noqa: BLE001
            failed_users += 1
            log.error("Sync mislukt voor gebruiker %s: %s", user_id, e)

    log.info("Klaar. %d ronde(s) toegevoegd, %d gebruiker(s) mislukt.", total_added, failed_users)
    if failed_users and total_added == 0:
        sys.exit(1)


if __name__ == "__main__":
    run_main(main)
