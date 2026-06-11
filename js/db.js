import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

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
  "holes_data", "screenshots", "notes",
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
  console.log("[initDb] Starting with URL:", SUPABASE_URL?.slice(0, 20) + "...");
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      console.log("[initDb] Importing @supabase/supabase-js from esm.sh...");
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
      console.log("[initDb] Creating Supabase client...");
      client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      mode = "supabase";
      console.log("[initDb] Supabase mode activated");
    } catch (e) {
      console.error("[initDb] Supabase import/init failed:", e.message, e);
      mode = "local";
    }
  } else {
    console.log("[initDb] No Supabase credentials, using local mode");
  }

  if (mode === "local" && localStorage.getItem(LS_KEY) === null) {
    writeLocal(SEED_ROUNDS.map((r) => ({ ...pick(r), id: crypto.randomUUID() })));
  }
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

async function accessToken() {
  const { data } = await client.auth.getSession();
  return data.session?.access_token || null;
}

export async function getRounds() {
  if (mode === "supabase") {
    const { data, error } = await client
      .from(TABLE).select("*").order("date", { ascending: true });
    if (error) throw error;
    return data;
  }
  return readLocal().slice().sort((a, b) => a.date.localeCompare(b.date));
}

export async function addRound(round) {
  const row = pick(round);
  if (mode === "supabase") {
    const { data, error } = await client.from(TABLE).insert(row).select().single();
    if (error) throw error;
    return data;
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
    const { data, error } = await client.from(TABLE).update(row).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }
  const rows = readLocal();
  const i = rows.findIndex((r) => r.id === id);
  if (i !== -1) { rows[i] = { ...rows[i], ...row }; writeLocal(rows); }
  return rows[i];
}

export async function deleteRound(id) {
  if (mode === "supabase") {
    const { error } = await client.from(TABLE).delete().eq("id", id);
    if (error) throw error;
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
