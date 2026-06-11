// Supabase Edge Function: save-golfnl-creds
// -------------------------------------------------------------------
// Ontvangt username + password van een ingelogde gebruiker,
// versleutelt het wachtwoord met AES-256-GCM en slaat het op in
// user_settings. Het wachtwoord wordt nooit in plaintext opgeslagen.
//
// Deploy:
//   supabase functions deploy save-golfnl-creds
//   supabase secrets set GOLF_ENCRYPT_KEY=<64-char hex, 32 bytes>
//
// Genereer een sleutel:
//   python3 -c "import secrets; print(secrets.token_hex(32))"
// Dezelfde sleutel ook als GitHub Actions secret GOLF_ENCRYPT_KEY opslaan.
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
  const pairs = hex.match(/.{2}/g) ?? [];
  return new Uint8Array(pairs.map((b) => parseInt(b, 16)));
}

async function encryptPassword(password: string, hexKey: string): Promise<string> {
  const keyBytes = hexToBytes(hexKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    new TextEncoder().encode(password),
  );
  // Combineer iv (12 bytes) + versleutelde data (incl. 16-byte auth-tag)
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  return btoa(String.fromCharCode(...combined));
}

async function getUser(jwt: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function upsertSettings(userId: string, username: string, encryptedPassword: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_settings`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal,resolution=merge-duplicates",
    },
    body: JSON.stringify({
      user_id: userId,
      golfnl_username: username,
      golfnl_password: encryptedPassword,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `DB fout ${res.status}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!ENCRYPT_KEY_HEX) return json({ error: "GOLF_ENCRYPT_KEY niet ingesteld op de server" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet geauthenticeerd" }, 401);

  const user = await getUser(jwt);
  if (!user?.id) return json({ error: "Ongeldige sessie" }, 401);

  let username: string, password: string;
  try {
    const body = await req.json();
    username = body.username?.trim();
    password = body.password;
    if (!username || !password) throw new Error();
  } catch {
    return json({ error: "username en password zijn verplicht" }, 400);
  }

  try {
    const encrypted = await encryptPassword(password, ENCRYPT_KEY_HEX);
    await upsertSettings(user.id, username, encrypted);
    return json({ ok: true });
  } catch (e) {
    return json({ error: "Opslaan mislukt: " + String(e) }, 500);
  }
});
