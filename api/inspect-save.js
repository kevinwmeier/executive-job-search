// Read-only: dumps each scraper's batching code and Google Sheets save-node config (script URL redacted).
const N8N_BASE = "https://n8n-production-97a9.up.railway.app";

const SCRAPER_IDS = [
  { id: "uM7rHp7yPmIavmzH", name: "Boyden 2" },
  { id: "05U90dFzEMUgmZm6", name: "Goldbeck Scraper" },
  { id: "AE8M1Jq2VAbyArZZ", name: "Caldwell Scraper" },
  { id: "UA3lipRMMxnryYbF", name: "MacDonald Scraper" },
  { id: "9uwWWvU8AjzoX0b9", name: "Leaders Int. Scraper" },
  { id: "NejukFelgDuBB4so", name: "LMI Scraper" },
  { id: "3CuPKUDQ0ZmxqJ9o", name: "PFM Search Scraper" },
  { id: "cyQmfpOszbmR5iTe", name: "PFM Scraper" },
  { id: "1nCsCgtVpPBtdPbd", name: "Nelson & Kraft Scraper" },
];

const redact = (s) => s.replace(/script\.google\.com\/macros\/s\/[^/"'\s]+/g, "script.google.com/macros/s/<REDACTED>");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!process.env.N8N_API_KEY) return res.status(500).json({ error: "N8N_API_KEY not set" });

  const only = req.query?.id;
  const out = [];
  for (const s of SCRAPER_IDS.filter((x) => !only || x.id === only)) {
    try {
      const r = await fetch(`${N8N_BASE}/api/v1/workflows/${s.id}`, {
        headers: { "X-N8N-API-KEY": process.env.N8N_API_KEY },
      });
      if (!r.ok) { out.push({ name: s.name, error: r.status }); continue; }
      const wf = await r.json();
      const nodes = wf.nodes || [];
      const dump = (n) => JSON.parse(redact(JSON.stringify({ name: n.name, type: n.type.split(".").pop(), parameters: n.parameters })));
      out.push({
        name: s.name,
        order: nodes.map((n) => n.name),
        active: wf.active,
        nodeFlags: nodes
          .map((n) => ({
            name: n.name,
            alwaysOutputData: n.alwaysOutputData,
            executeOnce: n.executeOnce,
            onError: n.onError,
            continueOnFail: n.continueOnFail,
            retryOnFail: n.retryOnFail,
            disabled: n.disabled,
            mode: n.parameters?.mode,
          }))
          .filter((f) => Object.entries(f).some(([k, v]) => k !== "name" && v !== undefined && v !== false)),
        connections: Object.fromEntries(
          Object.entries(wf.connections || {}).map(([k, v]) => [k, (v.main?.[0] || []).map((c) => c.node)])
        ),
        batchNodes: nodes.filter((n) => /batch/i.test(n.name)).map(dump),
        saveNodes: nodes
          .filter((n) => n.type.endsWith("httpRequest") && JSON.stringify(n.parameters).includes("script.google.com"))
          .map(dump),
      });
    } catch (e) {
      out.push({ name: s.name, error: e.message });
    }
  }
  return res.status(200).json(out);
}
