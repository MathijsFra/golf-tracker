// Supabase Edge Function: get-garmin-creds
// -------------------------------------------------------------------
// Geeft de Garmin-credentials + sessietoken terug voor alle gebruikers,
// met wachtwoord en token ontsleuteld. Alleen toegankelijk met de
// service-role key. Bedoeld voor het sync-script (GitHub Actions).
//
// Deploy:
//   supabase functions deploy get-garmin-creds --no-verify-jwt
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

async function decrypt(ciphertext: string, hexKey: string): Promise<string> {
  const keyBytes = hexToBytes(hexKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"],
  );
  const data = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const iv = data.slice(0, 12);
  const ctTag = data.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ctTag);
  return new TextDecoder().decode(plain);
}

async function tryDecrypt(value: string | null, hexKey: string): Promise<string | null> {
  if (!value) return null;
  try {
    return await decrypt(value, hexKey);
  } catch {
    return value; // plaintext fallback
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Unauthorized" }, 401);

  if (!ENCRYPT_KEY_HEX) return json({ error: "GOLF_ENCRYPT_KEY niet ingesteld" }, 500);

  // Verifieer via DB-query: alleen service_role ziet alle rijen.
  const dbUrl = `${SUPABASE_URL}/rest/v1/user_settings?select=user_id,garmin_username,garmin_password,garmin_token&garmin_username=not.is.null`;
  const res = await fetch(dbUrl, {
    headers: { "apikey": token, "Authorization": `Bearer ${token}` },
  });

  if (!res.ok) return json({ error: "Forbidden" }, 403);

  const rows: {
    user_id: string;
    garmin_username: string;
    garmin_password: string | null;
    garmin_token: string | null;
  }[] = await res.json();

  const result = await Promise.all(rows.map(async (row) => ({
    user_id: row.user_id,
    garmin_username: row.garmin_username,
    garmin_password: await tryDecrypt(row.garmin_password, ENCRYPT_KEY_HEX),
    garmin_token: await tryDecrypt(row.garmin_token, ENCRYPT_KEY_HEX),
  })));

  return json(result);
});
