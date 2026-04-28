/**
 * Fixes the DeDupe node in all scraper workflows.
 *
 * Problem: The current DeDupe code makes ONE Airtable API call per job URL
 * (e.g. 50 jobs = 50 individual API requests). With 9 scrapers running daily,
 * this floods Airtable with requests and triggers HTTP 429 rate limiting.
 *
 * Fix: Batch-fetch ALL existing URLs in 1-2 paginated calls, then filter locally.
 * Reduces from ~50 requests per scraper to 1-2 requests — a 25-50x improvement.
 */

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

const SAFE_SETTING_KEYS = [
  "executionOrder", "saveManualExecutions", "callerPolicy",
  "errorWorkflow", "timezone", "saveExecutionProgress",
  "saveDataErrorExecution", "saveDataSuccessExecution",
];

function buildBatchDedupeCode(airtableToken, airtableBase) {
  return `// Batch-fetch all existing URLs in one paginated call (fixes Airtable 429 rate limiting)
const TOKEN = '${airtableToken}';
const BASE = '${airtableBase}';

const existingUrls = new Set();
let offset = '';
do {
  const pageUrl = \`https://api.airtable.com/v0/\${BASE}/Roles?fields[]=URL&pageSize=100\${offset ? '&offset=' + offset : ''}\`;
  const resp = await this.helpers.httpRequest({
    method: 'GET',
    url: pageUrl,
    headers: { 'Authorization': 'Bearer ' + TOKEN },
  });
  for (const record of (resp.records || [])) {
    if (record.fields && record.fields.URL) existingUrls.add(record.fields.URL);
  }
  offset = resp.offset || '';
} while (offset);

const results = [];
for (const item of $input.all()) {
  const url = item.json.url;
  if (!url) continue;
  if (!existingUrls.has(url)) results.push(item);
}
return results;`;
}

function extractAirtableToken(code) {
  const m = code.match(/'Authorization':\s*'Bearer\s+(pat[^']+)'/);
  return m ? m[1] : null;
}

function extractAirtableBase(code) {
  const m = code.match(/\/v0\/(app[A-Za-z0-9]+)\//);
  return m ? m[1] : null;
}

function isDedupeNode(node) {
  if (node.type !== "n8n-nodes-base.code") return false;
  const code = node.parameters?.jsCode || node.parameters?.functionCode || "";
  return code.includes("filterByFormula") || (code.includes("airtable.com") && code.includes("existingUrls") === false);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "N8N_API_KEY not set" });

  const dryRun = req.method === "GET" || req.query?.dry === "true";
  const headers = { "X-N8N-API-KEY": apiKey, "Content-Type": "application/json" };
  const results = [];

  for (const scraper of SCRAPER_IDS) {
    const result = { id: scraper.id, name: scraper.name, status: "unknown", dedupeFound: false };

    try {
      // Fetch workflow
      const wfRes = await fetch(`${N8N_BASE}/api/v1/workflows/${scraper.id}`, { headers });
      if (!wfRes.ok) { result.status = `fetch_failed_${wfRes.status}`; results.push(result); continue; }
      const wf = await wfRes.json();

      // Find the DeDupe / Airtable-checking code node
      const dedupeNode = (wf.nodes || []).find(isDedupeNode);

      if (!dedupeNode) {
        // Show all nodes to help debug
        result.status = "no_dedupe_node_found";
        result.allNodes = (wf.nodes || []).map(n => ({ name: n.name, type: n.type.split('.').pop() }));
        result.codeNodeCodes = (wf.nodes || [])
          .filter(n => n.type === "n8n-nodes-base.code")
          .map(n => ({
            name: n.name,
            codeSnippet: (n.parameters?.jsCode || n.parameters?.functionCode || "").slice(0, 300),
          }));
        results.push(result);
        continue;
      }

      result.dedupeFound = true;
      result.dedupeNodeName = dedupeNode.name;

      const existingCode = dedupeNode.parameters?.jsCode || dedupeNode.parameters?.functionCode || "";
      const token = extractAirtableToken(existingCode);
      const base = extractAirtableBase(existingCode);

      if (!token || !base) {
        result.status = "could_not_extract_token_or_base";
        result.codeSnippet = existingCode.slice(0, 200);
        results.push(result);
        continue;
      }

      result.airtableBase = base;

      if (dryRun) {
        result.status = "would_fix";
        result.newCode = buildBatchDedupeCode(token, base).slice(0, 100) + "...";
        results.push(result);
        continue;
      }

      // Apply fix: update the node code
      const newCode = buildBatchDedupeCode(token, base);
      const updatedNodes = wf.nodes.map(n =>
        n.name === dedupeNode.name
          ? { ...n, parameters: { ...n.parameters, jsCode: newCode } }
          : n
      );

      // Sanitise settings
      const safeSettings = {};
      for (const k of SAFE_SETTING_KEYS) {
        if (wf.settings?.[k] !== undefined) safeSettings[k] = wf.settings[k];
      }

      // Deactivate
      await fetch(`${N8N_BASE}/api/v1/workflows/${scraper.id}/deactivate`, { method: "POST", headers });

      // PUT updated workflow
      const putRes = await fetch(`${N8N_BASE}/api/v1/workflows/${scraper.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: wf.name, nodes: updatedNodes, connections: wf.connections, settings: safeSettings }),
      });

      if (!putRes.ok) {
        const errText = await putRes.text();
        result.status = `put_failed: ${errText.slice(0, 200)}`;
        // Re-activate even on failure
        await fetch(`${N8N_BASE}/api/v1/workflows/${scraper.id}/activate`, { method: "POST", headers });
        results.push(result);
        continue;
      }

      // Reactivate
      await fetch(`${N8N_BASE}/api/v1/workflows/${scraper.id}/activate`, { method: "POST", headers });

      result.status = "fixed";
      results.push(result);

    } catch (e) {
      result.status = `error: ${e.message}`;
      results.push(result);
    }
  }

  const fixed = results.filter(r => r.status === "fixed").length;
  const wouldFix = results.filter(r => r.status === "would_fix").length;

  return res.status(200).json({
    dryRun,
    summary: dryRun ? `${wouldFix}/${SCRAPER_IDS.length} workflows would be updated` : `${fixed}/${SCRAPER_IDS.length} workflows fixed`,
    results,
  });
}
