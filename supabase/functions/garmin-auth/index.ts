// Supabase Edge Function: garmin-auth
// -------------------------------------------------------------------
// GET  → geeft huidige garmin_auth_status + garmin_auth_error terug
// POST → slaat de OTP op (body: { otp: string })
//
// Vereist een geldig gebruikers-JWT (verify_jwt=true).
//
// Deploy:
//   supabase functions deploy garmin-auth
// -------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

async function getUser(jwt: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.id ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet geauthenticeerd" }, 401);

  const userId = await getUser(jwt);
  if (!userId) return json({ error: "Ongeldige sessie" }, 401);

  // GET: status ophalen
  if (req.method === "GET") {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_settings?user_id=eq.${userId}&select=garmin_auth_status,garmin_auth_error`,
      {
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!res.ok) return json({ error: "DB fout" }, 500);
    const rows = await res.json();
    const row = rows[0] ?? {};
    return json({ status: row.garmin_auth_status ?? null, error: row.garmin_auth_error ?? null });
  }

  // POST: OTP opslaan
  if (req.method === "POST") {
    let otp: string;
    try {
      const body = await req.json();
      otp = String(body.otp ?? "").trim();
      if (!otp) throw new Error();
    } catch {
      return json({ error: "otp is verplicht" }, 400);
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_settings?user_id=eq.${userId}`,
      {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({ garmin_auth_otp: otp }),
      },
    );
    if (!res.ok) return json({ error: "DB fout" }, 500);
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
});
