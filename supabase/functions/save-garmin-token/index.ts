// Supabase Edge Function: save-garmin-token
// -------------------------------------------------------------------
// Slaat een vernieuwd Garmin-sessietoken versleuteld op in user_settings.
// Wordt aangeroepen door garmin_login.py (eenmalige setup) en door
// sync_garmin.py (token vernieuwen na elke succesvolle sync).
// Auth: service-role key als Bearer (--no-verify-jwt).
// -------------------------------------------------------------------

const ENCRYPT_KEY_HEX = Deno.env.get("GOLF_ENCRYPT_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
}

async function encryptValue(plaintext: string, hexKey: string): Promise<string> {
  const keyBytes = hexToBytes(hexKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  return btoa(String.fromCharCode(...combined));
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Unauthorized" }, 401);

  if (!ENCRYPT_KEY_HEX) return json({ error: "GOLF_ENCRYPT_KEY niet ingesteld" }, 500);

  // Verifieer dat het de service-role key is via een DB-query.
  const testRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_settings?select=user_id&limit=1`,
    { headers: { "apikey": token, "Authorization": `Bearer ${token}` } },
  );
  if (!testRes.ok) return json({ error: "Forbidden" }, 403);

  let userId: string, garminToken: string;
  try {
    const body = await req.json();
    userId = body.user_id?.trim();
    garminToken = body.token;
    if (!userId || !garminToken) throw new Error();
  } catch {
    return json({ error: "user_id en token zijn verplicht" }, 400);
  }

  const encrypted = await encryptValue(garminToken, ENCRYPT_KEY_HEX);

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_settings?user_id=eq.${userId}`,
    {
      method: "PATCH",
      headers: {
        "apikey": token,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({ garmin_token: encrypted, updated_at: new Date().toISOString() }),
    },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: "DB fout: " + (err.message || res.status) }, 500);
  }

  return json({ ok: true });
});
