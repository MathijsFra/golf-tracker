// Disables RLS on rounds table for debugging
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

export async function handler(req: Request) {
  try {
    const client = createClient(supabaseUrl, supabaseServiceKey);

    // Execute SQL with service role (bypasses RLS)
    const { data, error } = await client.rpc("sql", {
      query: "alter table public.rounds disable row level security;"
    });

    if (error) throw error;

    return new Response(JSON.stringify({ success: true, message: "RLS disabled" }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

Deno.serve(handler);
