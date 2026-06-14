// Supabase Edge Function: test-llm
// -----------------------------------------------------------
// Minimale testfunctie voor LLM-providers zonder user-auth.
// Roept de provider aan met een hardcoded ping-prompt en
// geeft ok/error terug. Alleen bedoeld voor debugging.
// -----------------------------------------------------------

const GROQ_API_KEY   = Deno.env.get("GROQ_API_KEY")   ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")  ?? "";

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

const PING_PROMPT = `Respond with exactly this JSON and nothing else: {"ok": true, "msg": "pong"}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let provider = "groq";
  try {
    const body = await req.json();
    if (body.provider === "gemini") provider = "gemini";
  } catch { /* default to groq */ }

  try {
    if (provider === "gemini") {
      if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY niet ingesteld" }, 500);

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: PING_PROMPT }] }],
            generationConfig: { responseMimeType: "application/json", maxOutputTokens: 50 },
          }),
        }
      );
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        const err = data.error as Record<string, unknown> | undefined;
        return json({ ok: false, provider: "gemini", error: err?.message ?? `HTTP ${res.status}`, raw: data });
      }
      const candidates = data.candidates as Array<{ content: { parts: Array<{ text: string }> } }>;
      const text = candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      return json({ ok: true, provider: "gemini", model: "gemini-2.5-flash", response: text });
    }

    // Groq
    if (!GROQ_API_KEY) return json({ error: "GROQ_API_KEY niet ingesteld" }, 500);
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: PING_PROMPT }],
        max_tokens: 50,
        response_format: { type: "json_object" },
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      const err = data.error as Record<string, unknown> | undefined;
      return json({ ok: false, provider: "groq", error: err?.message ?? `HTTP ${res.status}`, raw: data });
    }
    const choices = data.choices as Array<{ message: { content: string } }>;
    const text = choices?.[0]?.message?.content ?? "";
    return json({ ok: true, provider: "groq", model: "llama-3.3-70b-versatile", response: text });
  } catch (e) {
    return json({ ok: false, provider, error: String(e) }, 500);
  }
});
