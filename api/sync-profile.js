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
];

function injectProfile(jsCode, titlesArray, locationsArray) {
  let code = jsCode;
  code = code.replace(
    /const targetTitles\s*=\s*\[[\s\S]*?\];/,
    `const targetTitles = ${JSON.stringify(titlesArray)};`
  );
  if (locationsArray.length > 0) {
    code = code.replace(
      /const (targetLocations|canadianTerms|canadianLocations)\s*=\s*\[[\s\S]*?\];/,
      (_, varName) => `const ${varName} = ${JSON.stringify(locationsArray)};`
    );
  }
  return code;
}

async function n8nFetch(path, options = {}) {
  const apiKey = process.env.N8N_API_KEY;
  return fetch(`${N8N_BASE}/api/v1${path}`, {
    ...options,
    headers: {
      "X-N8N-API-KEY": apiKey,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) {
    console.error("[sync-profile] N8N_API_KEY is not set");
    return res.status(500).json({ error: "N8N_API_KEY is not set in Vercel environment variables." });
  }

  const { titles, locations } = req.body || {};
  if (!titles?.trim()) return res.status(400).json({ error: "titles is required" });

  const titlesArray = titles.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const locationsArray = (locations || "")
    .replace(/\([^)]*\)/g, "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const results = [];

  for (const { id, name } of SCRAPER_IDS) {
    try {
      // 1. Fetch current workflow
      const getRes = await n8nFetch(`/workflows/${id}`);
      if (!getRes.ok) {
        const errText = await getRes.text().catch(() => "");
        console.error(`[sync-profile] GET ${name} failed: ${getRes.status} ${errText}`);
        results.push({ id, name, status: "error", message: `Could not fetch workflow (${getRes.status})` });
        continue;
      }
      const wf = await getRes.json();

      // 2. Find and update code nodes containing targetTitles
      let modified = false;
      const updatedNodes = (wf.nodes || []).map((node) => {
        if (node.type === "n8n-nodes-base.code" && node.parameters?.jsCode?.includes("targetTitles")) {
          modified = true;
          return {
            ...node,
            parameters: {
              ...node.parameters,
              jsCode: injectProfile(node.parameters.jsCode, titlesArray, locationsArray),
            },
          };
        }
        return node;
      });

      if (!modified) {
        results.push({ id, name, status: "skipped", message: "No targetTitles found" });
        continue;
      }

      // 3. Deactivate first — n8n rejects PUT on active workflows
      if (wf.active) {
        const deactivateRes = await n8nFetch(`/workflows/${id}/deactivate`, { method: "POST" });
        if (!deactivateRes.ok) {
          const errText = await deactivateRes.text().catch(() => "");
          console.error(`[sync-profile] Deactivate ${name} failed: ${deactivateRes.status} ${errText}`);
          results.push({ id, name, status: "error", message: `Could not deactivate before update (${deactivateRes.status})` });
          continue;
        }
      }

      // 4. PUT the updated workflow (versionId required by newer n8n to prevent conflicts)
      const putRes = await n8nFetch(`/workflows/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: wf.name,
          nodes: updatedNodes,
          connections: wf.connections,
          settings: wf.settings,
          staticData: wf.staticData || null,
          ...(wf.versionId ? { versionId: wf.versionId } : {}),
        }),
      });

      if (!putRes.ok) {
        const rawText = await putRes.text().catch(() => "");
        let errMsg = `PUT failed (${putRes.status})`;
        try { const b = JSON.parse(rawText); errMsg = b.message || b.error || JSON.stringify(b); } catch { errMsg = rawText || errMsg; }
        console.error(`[sync-profile] PUT ${name} failed: ${putRes.status} — ${errMsg}`);
        // Try to reactivate even if PUT failed
        if (wf.active) {
          await n8nFetch(`/workflows/${id}/activate`, { method: "POST" }).catch(() => {});
        }
        results.push({ id, name, status: "error", message: errMsg });
        continue;
      }

      // 5. Reactivate
      if (wf.active) {
        const activateRes = await n8nFetch(`/workflows/${id}/activate`, { method: "POST" });
        if (!activateRes.ok) {
          console.error(`[sync-profile] Reactivate ${name} failed after successful update`);
          // Still count as updated — the code change went through, just needs manual reactivation
          results.push({ id, name, status: "updated", message: "Updated but could not reactivate — check n8n" });
          continue;
        }
      }

      results.push({ id, name, status: "updated" });
    } catch (e) {
      console.error(`[sync-profile] Unexpected error for ${name}:`, e.message);
      results.push({ id, name, status: "error", message: e.message });
    }
  }

  const updated = results.filter((r) => r.status === "updated").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errors  = results.filter((r) => r.status === "error").length;

  return res.status(200).json({
    success: errors === 0,
    summary: `${updated} updated, ${skipped} skipped, ${errors} failed`,
    titlesUsed: titlesArray,
    locationsUsed: locationsArray,
    results,
  });
}
