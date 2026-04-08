const N8N_BASE = "https://n8n-production-97a9.up.railway.app";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.N8N_API_KEY;

  // Log all N8N-related env var names present (not values) to help diagnose scope issues
  const allN8nKeys = Object.keys(process.env).filter(k => k.includes("N8N") || k.includes("n8n"));
  console.log("[test-n8n] N8N-related env vars present:", allN8nKeys.length ? allN8nKeys : "none");

  if (!apiKey) {
    // Return all env var NAMES containing "n8n" or "api" (case-insensitive) to help spot typos
    const similarKeys = Object.keys(process.env).filter(k =>
      k.toLowerCase().includes("n8n") || k.toLowerCase().includes("api_key")
    );
    console.log("[test-n8n] N8N_API_KEY missing. Similar keys visible:", similarKeys);
    return res.status(200).json({
      ok: false,
      message: "N8N_API_KEY is not set in Vercel environment variables",
      hint: "In Vercel → Settings → Environment Variables, make sure N8N_API_KEY has the Production environment checked, then redeploy.",
      similarKeysVisible: similarKeys,
    });
  }

  // Ping the n8n API to confirm the key actually works
  try {
    const r = await fetch(`${N8N_BASE}/api/v1/workflows?limit=1`, {
      headers: { "X-N8N-API-KEY": apiKey },
    });

    if (r.status === 401) {
      return res.status(200).json({ ok: false, message: "N8N_API_KEY is set but rejected by n8n (invalid key)" });
    }
    if (!r.ok) {
      return res.status(200).json({ ok: false, message: `n8n API returned ${r.status}` });
    }

    return res.status(200).json({ ok: true, message: "N8N_API_KEY is set and verified" });
  } catch (e) {
    return res.status(200).json({ ok: false, message: `Could not reach n8n: ${e.message}` });
  }
}
