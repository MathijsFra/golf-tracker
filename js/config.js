// ============================================================
//  Supabase configuratie
// ------------------------------------------------------------
//  Vul deze twee waarden in om je rondes in de cloud op te slaan
//  (zodat ze op al je apparaten beschikbaar zijn).
//
//  Vind ze in Supabase: Project Settings -> API
//    - SUPABASE_URL      = "Project URL"
//    - SUPABASE_ANON_KEY = "anon public" key
//
//  Laat ze leeg om de app puur lokaal (in je browser) te gebruiken.
//  De anon-key is veilig om publiek te tonen mits RLS aanstaat
//  (zie supabase/schema.sql).
// ============================================================

// DEV_MODE werkt uitsluitend op localhost — productiegebruikers kunnen dit niet activeren.
const _onLocalhost = typeof window !== "undefined" && window.location.hostname === "localhost";
const _devMode = _onLocalhost && typeof localStorage !== "undefined" && localStorage.getItem("DEV_MODE") === "true";

export const SUPABASE_URL      = _devMode ? "http://localhost:3001"                         : "https://ptrccpfqnvygrqmsykob.supabase.co";
export const SUPABASE_ANON_KEY = _devMode ? "dev-anon-key"                                 : "sb_publishable_mY2XiMffONLDlVLDOnkTqw_vEgP9Iwd";

export const GITHUB_REPO = "mathijsfra/road-to-scratch";
