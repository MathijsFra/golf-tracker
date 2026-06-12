// Supabase Edge Function: save-toptracer-creds
// -------------------------------------------------------------------
// Slaat Toptracer-credentials versleuteld op in user_settings.
// De sync-script gebruikt ze voor automatische headless login.
// body: { email: string, password: string }
// -------------------------------------------------------------------

const ENCRYPT_KEY_HEX = Deno.env.get("GOLF_ENCRYPT_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
}

async function encryptValue(plaintext: string): Promise<string> {
  const keyBytes = hexToBytes(ENCRYPT_KEY_HEX);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  return btoa(String.fromCharCode(...combined));
}

async function getUser(jwt: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { "Authorization": `Bearer ${jwt}`, "apikey": SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!res.ok) return null;
  return (await res.json())?.id ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!ENCRYPT_KEY_HEX) return json({ error: "GOLF_ENCRYPT_KEY niet ingesteld" }, 500);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet geauthenticeerd" }, 401);

  const userId = await getUser(jwt);
  if (!userId) return json({ error: "Ongeldige sessie" }, 401);

  let email: string, password: string;
  try {
    const body = await req.json();
    email = String(body.email ?? "").trim();
    password = String(body.password ?? "");
    if (!email || !password) throw new Error();
  } catch {
    return json({ error: "email en password zijn verplicht" }, 400);
  }

  const [encEmail, encPassword] = await Promise.all([
    encryptValue(email),
    encryptValue(password),
  ]);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      toptracer_email: encEmail,
      toptracer_password: encPassword,
      toptracer_auth_status: "credentials_saved",
      toptracer_auth_error: null,
      toptracer_username: email,
    }),
  });

  if (!res.ok) return json({ error: "Opslaan mislukt" }, 500);
  return json({ ok: true });
});
