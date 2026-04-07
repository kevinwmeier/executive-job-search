const N8N_BASE = "https://n8n-production-97a9.up.railway.app";

// All scraper workflow IDs — skip API workflows and non-JS scrapers
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

/**
 * Replaces the targetTitles array and whichever location array variable
 * the workflow uses (targetLocations / canadianTerms / canadianLocations).
 * Preserves the original variable name so the rest of the code doesn't break.
 */
function injectProfile(jsCode, titlesArray, locationsArray) {
  let code = jsCode;

  // Replace targetTitles array
  code = code.replace(
    /const targetTitles\s*=\s*\[[\s\S]*?\];/,
    `const targetTitles = ${JSON.stringify(titlesArray)};`
  );

  // Replace location array — preserve whichever variable name the workflow uses
  if (locationsArray.length > 0) {
    code = code.replace(
      /const (targetLocations|canadianTerms|canadianLocations)\s*=\s*\[[\s\S]*?\];/,
      (_, varName) => `const ${varName} = ${JSON.stringify(locationsArray)};`
    );
  }

  return code;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) {
    console.error("[sync-profile] N8N_API_KEY is not set in Vercel environment variables");
    return res.status(500).json({ error: "N8N_API_KEY is not set in Vercel environment variables. Add it under Vercel → Settings → Environment Variables." });
  }

  const { titles, locations } = req.body || {};
  if (!titles || !titles.trim()) {
    return res.status(400).json({ error: "titles is required" });
  }

  // Parse "Chief Operating Officer, COO, VP Operations" → ["chief operating officer", "coo", "vp operations"]
  const titlesArray = titles
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  // Parse "BC, Vancouver, Remote" → ["bc", "vancouver", "remote"]
  // Strips parenthetical notes like "(remote/hybrid considered)"
  const locationsArray = (locations || "")
    .replace(/\([^)]*\)/g, "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  const results = [];

  for (const { id, name } of SCRAPER_IDS) {
    try {
      // 1. Fetch the current workflow definition
      const getRes = await fetch(`${N8N_BASE}/api/v1/workflows/${id}`, {
        headers: { "X-N8N-API-KEY": apiKey, "Content-Type": "application/json" },
      });

      if (!getRes.ok) {
        const errText = await getRes.text().catch(() => "");
        console.error(`[sync-profile] GET workflow ${id} (${name}) failed: ${getRes.status} ${errText}`);
        results.push({ id, name, status: "error", message: `Fetch failed: ${getRes.status} ${errText}` });
        continue;
      }

      const wf = await getRes.json();

      // 2. Find code nodes that contain targetTitles and inject the profile
      let modified = false;
      const updatedNodes = (wf.nodes || []).map((node) => {
        if (
          node.type === "n8n-nodes-base.code" &&
          node.parameters?.jsCode?.includes("targetTitles")
        ) {
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
        results.push({ id, name, status: "skipped", message: "No targetTitles found in code nodes" });
        continue;
      }

      // 3. PUT the updated workflow back to n8n
      const putRes = await fetch(`${N8N_BASE}/api/v1/workflows/${id}`, {
        method: "PUT",
        headers: { "X-N8N-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: wf.name,
          nodes: updatedNodes,
          connections: wf.connections,
          settings: wf.settings,
          staticData: wf.staticData || null,
        }),
      });

      if (!putRes.ok) {
        const errBody = await putRes.json().catch(() => ({}));
        console.error(`[sync-profile] PUT workflow ${id} (${name}) failed: ${putRes.status}`, errBody);
        results.push({
          id, name, status: "error",
          message: errBody.message || `PUT failed: ${putRes.status}`,
        });
        continue;
      }

      // 4. Re-activate if the workflow was active (PUT can deactivate it in some n8n versions)
      if (wf.active) {
        await fetch(`${N8N_BASE}/api/v1/workflows/${id}/activate`, {
          method: "POST",
          headers: { "X-N8N-API-KEY": apiKey },
        }).catch(() => {}); // non-fatal if this fails
      }

      results.push({ id, name, status: "updated" });
    } catch (e) {
      console.error(`[sync-profile] Unexpected error for workflow ${id} (${name}):`, e.message);
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
