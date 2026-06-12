// Supabase Edge Function: get-toptracer-creds
// -------------------------------------------------------------------
// Geeft de Toptracer refresh-tokens terug voor alle gekoppelde gebruikers,
// ontsleuteld. Alleen toegankelijk met de service-role key.
// Bedoeld voor het sync-script (GitHub Actions).
//
// Deploy:
//   supabase functions deploy get-toptracer-creds --no-verify-jwt
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

async function decrypt(ciphertext: string): Promise<string> {
  const keyBytes = hexToBytes(ENCRYPT_KEY_HEX);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"],
  );
  const data = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const iv = data.slice(0, 12);
  const ctTag = data.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ctTag);
  return new TextDecoder().decode(plain);
}

async function tryDecrypt(value: string | null): Promise<string | null> {
  if (!value) return null;
  try { return await decrypt(value); } catch { return value; }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Unauthorized" }, 401);
  if (!ENCRYPT_KEY_HEX) return json({ error: "GOLF_ENCRYPT_KEY niet ingesteld" }, 500);

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_settings?select=user_id,toptracer_username,toptracer_token,toptracer_email,toptracer_password&toptracer_email=not.is.null`,
    { headers: { "apikey": token, "Authorization": `Bearer ${token}` } },
  );
  if (!res.ok) return json({ error: "Forbidden" }, 403);

  const rows = await res.json() as {
    user_id: string;
    toptracer_username: string;
    toptracer_token: string | null;
    toptracer_email: string | null;
    toptracer_password: string | null;
  }[];

  const result = await Promise.all(rows.map(async (row) => ({
    user_id: row.user_id,
    toptracer_username: row.toptracer_username,
    toptracer_token: await tryDecrypt(row.toptracer_token),
    toptracer_email: await tryDecrypt(row.toptracer_email),
    toptracer_password: await tryDecrypt(row.toptracer_password),
  })));

  return json(result);
});
