const N8N_BASE = "https://n8n-production-97a9.up.railway.app";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.N8N_API_KEY;

  if (!apiKey) {
    return res.status(200).json({
      ok: false,
      message: "N8N_API_KEY is not set in Vercel environment variables",
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
