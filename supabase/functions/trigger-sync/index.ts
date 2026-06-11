// Supabase Edge Function: trigger-sync
// -------------------------------------------------------------------
// Triggert een GitHub Actions workflow dispatch als proxy. De GH_PAT
// staat als Edge Function secret, nooit in de browser.
//
// Deploy:
//   supabase functions deploy trigger-sync
//   supabase secrets set GH_PAT=github_pat_...
//
// De aanroepende gebruiker moet ingelogd zijn (JWT vereist).
// -------------------------------------------------------------------

const GH_PAT = Deno.env.get("GH_PAT") ?? "";
const GITHUB_REPO = Deno.env.get("GITHUB_REPO") ?? "mathijsfra/golf-tracker";
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!GH_PAT) return json({ error: "GH_PAT niet ingesteld op de server" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet geauthenticeerd" }, 401);

  const user = await getUser(jwt);
  if (!user?.id) return json({ error: "Ongeldige sessie" }, 401);

  let workflowFile: string;
  try {
    const body = await req.json();
    workflowFile = body.workflow;
    if (!workflowFile || typeof workflowFile !== "string") throw new Error();
  } catch {
    return json({ error: "Geef 'workflow' mee in de body (bv. sync-golfnl.yml)" }, 400);
  }

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GH_PAT}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: err.message || `GitHub API ${res.status}` }, res.status >= 500 ? 502 : 400);
  }

  return json({ ok: true });
});
