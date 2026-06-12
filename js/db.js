import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js?v=7";

// De 10 bekende startrondes (datum als ISO yyyy-mm-dd).
export const SEED_ROUNDS = [
  { date: "2025-11-07", course: "Zeewolde",          holes: 18, tee: "Geel", stb: 35, sd: 49.6, hcp: 47.6 },
  { date: "2025-12-30", course: "Harderwold",        holes: 9,  tee: "Geel", stb: 21, sd: 45.5, hcp: 43.5 },
  { date: "2026-03-14", course: "Zeewolde",          holes: 9,  tee: "Geel", stb: 20, sd: 42.7, hcp: 41.7 },
  { date: "2026-04-25", course: "Zeewolde",          holes: 18, tee: "Rood", stb: 36, sd: 42.7, hcp: 42.7 },
  { date: "2026-05-01", course: "De Scherpenbergh",  holes: 9,  tee: "Rood", stb: 18, sd: 44.6, hcp: 41.7 },
  { date: "2026-05-03", course: "Zeewolde",          holes: 9,  tee: "Geel", stb: 22, sd: 39.3, hcp: 41.0 },
  { date: "2026-05-08", course: "Zeewolde",          holes: 9,  tee: "Geel", stb: 21, sd: 38.9, hcp: 39.1 },
  { date: "2026-05-22", course: "Zeewolde",          holes: 9,  tee: "Rood", stb: 22, sd: 37.4, hcp: 38.5 },
  { date: "2026-05-29", course: "Putten",            holes: 9,  tee: "Geel", stb: 20, sd: 38.2, hcp: 38.2 },
  { date: "2026-06-04", course: "De Kroonprins",     holes: 18, tee: "Geel", stb: 45, sd: 30.1, hcp: 34.2 },
];

const LS_KEY = "golf_rounds_v1";
const TABLE = "rounds";
const BUCKET = "round-screenshots";

// Velden die we naar Supabase sturen (id/created_at worden door de DB beheerd).
const FIELDS = [
  "date", "course", "holes", "tee", "stb", "sd", "hcp",
  "score", "course_handicap", "putts", "penalties", "bunkers", "bunker_saves",
  "gir", "fairways_hit", "fairways_total", "three_putts", "double_bogeys",
  "holes_data", "screenshots", "notes", "non_qualifying",
];
const ARRAY_FIELDS = new Set(["holes_data", "screenshots"]);

let client = null;
let mode = "local"; // "local" | "supabase"

export function getMode() { return mode; }

function pick(obj) {
  const out = {};
  for (const f of FIELDS) {
    let v = obj[f];
    if (v === undefined || v === "") v = ARRAY_FIELDS.has(f) ? [] : null;
    if (ARRAY_FIELDS.has(f) && v === null) v = [];
    out[f] = v;
  }
  return out;
}

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function writeLocal(rows) {
  localStorage.setItem(LS_KEY, JSON.stringify(rows));
}

export async function initDb() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
      client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      mode = "supabase";
    } catch (e) {
      console.warn("Supabase niet beschikbaar, val terug op lokale opslag.", e);
      mode = "local";
    }
  }

  // Seed-data niet automatisch invoegen — nieuwe gebruikers beginnen leeg.
  return mode;
}

// ---------- Auth (alleen in supabase-modus) ----------
export async function getUser() {
  if (mode !== "supabase") return null;
  const { data } = await client.auth.getUser();
  return data.user || null;
}

export async function signIn(email, password) {
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.message.includes("Invalid login")) throw new Error("E-mail of wachtwoord incorrect.");
    throw error;
  }
}

export async function signOut() {
  if (mode === "supabase") await client.auth.signOut();
}

// Roept cb(user|null) aan bij elke login/logout/sessie-wijziging.
export function onAuthChange(cb) {
  if (mode !== "supabase") return;
  client.auth.onAuthStateChange((_event, session) => cb(session?.user || null));
}

// Leest het JWT-token direct uit localStorage (omzeilt getSession() die kan hangen).
function storedToken() {
  const projectRef = SUPABASE_URL.split("//")[1]?.split(".")[0];
  try {
    const raw = localStorage.getItem(`sb-${projectRef}-auth-token`);
    return raw ? JSON.parse(raw)?.access_token : null;
  } catch { return null; }
}

// Lichte wrapper om PostgREST te bevragen zonder via supabase-js client.auth te gaan.
async function pgrest(path, opts = {}) {
  const token = storedToken() || SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function accessToken() {
  return storedToken() || SUPABASE_ANON_KEY;
}

export async function getRounds() {
  if (mode === "supabase") {
    return await pgrest(
      `${TABLE}?select=*,course_tees(course_rating,slope_rating,par)&deleted_at=is.null&order=date`,
    );
  }
  return readLocal().slice().sort((a, b) => a.date.localeCompare(b.date));
}

export async function saveRoundInsights(id, insights) {
  if (mode !== "supabase") return;
  try {
    await pgrest(`${TABLE}?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ insights }),
      headers: { "Prefer": "return=minimal" },
    });
  } catch { /* fire-and-forget */ }
}

export async function addRound(round) {
  const row = pick(round);
  if (mode === "supabase") {
    const results = await pgrest(TABLE, {
      method: "POST",
      body: JSON.stringify(row),
      headers: { "Prefer": "return=representation" },
    });
    return Array.isArray(results) ? results[0] : results;
  }
  const rows = readLocal();
  const saved = { ...row, id: crypto.randomUUID() };
  rows.push(saved);
  writeLocal(rows);
  return saved;
}

export async function updateRound(id, round) {
  const row = pick(round);
  if (mode === "supabase") {
    const results = await pgrest(`${TABLE}?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify(row),
      headers: { "Prefer": "return=representation" },
    });
    return Array.isArray(results) ? results[0] : results;
  }
  const rows = readLocal();
  const i = rows.findIndex((r) => r.id === id);
  if (i !== -1) { rows[i] = { ...rows[i], ...row }; writeLocal(rows); }
  return rows[i];
}

export async function deleteRound(id) {
  if (mode === "supabase") {
    await pgrest(`${TABLE}?id=eq.${id}`, { method: "DELETE" });
    return;
  }
  writeLocal(readLocal().filter((r) => r.id !== id));
}

export async function softDeleteRound(id) {
  if (mode === "supabase") {
    await pgrest(`${TABLE}?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ deleted_at: new Date().toISOString() }),
      headers: { "Prefer": "return=minimal" },
    });
    return;
  }
  writeLocal(readLocal().filter((r) => r.id !== id));
}

// ---------- Screenshots ----------
// Verkleint een afbeelding client-side en geeft { dataUrl, base64, mediaType }.
export function processImage(file, maxDim = 1400, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const r = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * r);
          height = Math.round(height * r);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({
          dataUrl,
          base64: dataUrl.split(",")[1],
          mediaType: "image/jpeg",
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Slaat een verwerkte screenshot op. In de cloud: in je eigen map
// (<user-id>/<uuid>.jpg) in een privé-bucket; we bewaren het PAD in de DB.
// Lokaal: de (verkleinde) dataURL inline.
export async function saveScreenshot(processed) {
  if (mode === "supabase") {
    const user = await getUser();
    if (!user) throw new Error("Niet ingelogd.");
    const bytes = Uint8Array.from(atob(processed.base64), (c) => c.charCodeAt(0));
    const path = `${user.id}/${crypto.randomUUID()}.jpg`;
    const { error } = await client.storage.from(BUCKET).upload(path, bytes, {
      contentType: "image/jpeg", upsert: false,
    });
    if (error) throw error;
    return path;   // pad, niet de URL (bucket is privé)
  }
  return processed.dataUrl;
}

// Zet een opgeslagen screenshot-waarde om naar een toonbare URL.
// dataURL/http blijft zoals het is; een storage-pad -> tijdelijke signed URL.
export async function resolveScreenshot(value) {
  if (!value) return value;
  if (value.startsWith("data:") || value.startsWith("http")) return value;
  if (mode === "supabase") {
    const { data, error } = await client.storage.from(BUCKET).createSignedUrl(value, 3600);
    if (error) { console.warn("Signed URL mislukt", error); return null; }
    return data.signedUrl;
  }
  return value;
}

// ---------- Gebruikersinstellingen ----------
export async function signUp(email, password) {
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) {
    if (error.message.toLowerCase().includes("already registered")) {
      throw new Error("Dit e-mailadres is al geregistreerd.");
    }
    throw error;
  }
  return data;
}

export async function loadUserSettings() {
  if (mode !== "supabase") return {};
  try {
    const rows = await pgrest(
      "user_settings?select=golfnl_username,golfnl_sync_status,garmin_username,garmin_auth_status,toptracer_username,toptracer_auth_status,toptracer_auth_error&limit=1",
    );
    return Array.isArray(rows) && rows.length ? rows[0] : {};
  } catch { return {}; }
}

export async function getClubBag(period = "all") {
  if (mode !== "supabase") return [];
  try {
    const view = period === "recent" ? "toptracer_club_stats_recent" : "toptracer_club_stats";
    return await pgrest(`${view}?select=*`);
  } catch { return []; }
}

export async function getToptracerStatus() {
  if (mode !== "supabase") return { status: null, error: null, username: null };
  const token = await accessToken();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/toptracer-auth`, {
    headers: { "Authorization": `Bearer ${token}`, "apikey": SUPABASE_ANON_KEY },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function saveToptracerCredentials(email, password) {
  if (mode !== "supabase") return;
  const token = await accessToken();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/save-toptracer-creds`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function clearToptracerCredentials() {
  if (mode !== "supabase") return;
  const user = await getUser();
  if (!user) return;
  await pgrest(`user_settings?user_id=eq.${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      toptracer_email: null,
      toptracer_password: null,
      toptracer_token: null,
      toptracer_auth_status: null,
      toptracer_auth_error: null,
      toptracer_username: null,
    }),
    headers: { "Prefer": "return=minimal" },
  });
}

export async function clearGolfnlCredentials() {
  if (mode !== "supabase") return;
  const user = await getUser();
  if (!user) return;
  await pgrest(`user_settings?user_id=eq.${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      golfnl_username: null,
      golfnl_password: null,
      golfnl_sync_status: null,
    }),
    headers: { "Prefer": "return=minimal" },
  });
}

export async function clearGarminCredentials() {
  if (mode !== "supabase") return;
  const user = await getUser();
  if (!user) return;
  await pgrest(`user_settings?user_id=eq.${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      garmin_username: null,
      garmin_password: null,
      garmin_token: null,
      garmin_auth_status: null,
      garmin_auth_error: null,
      garmin_auth_otp: null,
    }),
    headers: { "Prefer": "return=minimal" },
  });
}

export async function resetGarminAuthStatus() {
  if (mode !== "supabase") return;
  try {
    const user = await getUser();
    if (!user) return;
    await pgrest(`user_settings?user_id=eq.${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ garmin_auth_status: null, garmin_auth_error: null }),
      headers: { "Prefer": "return=minimal" },
    });
  } catch { /* rij bestaat mogelijk nog niet — negeer */ }
}

// Slaat GOLF.NL-credentials op via de Edge Function (die het wachtwoord versleutelt).
export async function saveGolfnlCredentials(username, password) {
  if (mode !== "supabase") return;
  const token = await accessToken();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/save-golfnl-creds`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

// Slaat Garmin-credentials op via de Edge Function (die het wachtwoord versleutelt).
export async function saveGarminCredentials(username, password) {
  if (mode !== "supabase") return;
  const token = await accessToken();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/save-garmin-creds`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

// Triggert een GitHub Actions workflow via de Edge Function (geen PAT in de browser).
export async function triggerWorkflow(workflowFile, inputs = null) {
  if (mode !== "supabase") throw new Error("Sync vereist een cloud-verbinding.");
  const token = await accessToken();
  const body = { workflow: workflowFile };
  if (inputs) body.inputs = inputs;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/trigger-sync`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

// Triggert de garmin-auth workflow voor de ingelogde gebruiker.
export async function triggerGarminAuth() {
  const user = await getUser();
  if (!user?.id) throw new Error("Niet ingelogd.");
  await triggerWorkflow("garmin-auth.yml", { user_id: user.id });
}

// Geeft de huidige Garmin-koppelstatus terug: { status, error }
export async function getGarminAuthStatus() {
  if (mode !== "supabase") return { status: null, error: null };
  const token = await accessToken();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/garmin-auth`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "apikey": SUPABASE_ANON_KEY,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// Stuurt de OTP-code door naar de server zodat de wachtende workflow verder kan.
export async function submitGarminOtp(otp) {
  if (mode !== "supabase") return;
  const token = await accessToken();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/garmin-auth`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ otp }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

// Roept de Edge Function aan die Claude de screenshots laat uitlezen.
export async function parseScreenshots(processedImages) {
  if (mode !== "supabase") {
    throw new Error("AI-inlezen vereist een gekoppelde Supabase (zie config.js).");
  }
  const token = await accessToken();
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/parse-round`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": `Bearer ${token || SUPABASE_ANON_KEY}`,
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      images: processedImages.map((p) => ({ media_type: p.mediaType, data: p.base64 })),
    }),
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(out.error || `Inlezen mislukt (${resp.status})`);
  return out.round;
}
