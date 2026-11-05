/**
 * Stops the daily blank row in the Google Sheet.
 *
 * Cause: some DeDupe nodes have "Always Output Data" on, so an empty DeDupe result still
 * emits one {} item. Batch Roles then posts { roles: [{}] } and the Apps Script appends a
 * row with only id / Status / FetchedDate.
 *
 * Fix, per workflow:
 *   1. Turn off alwaysOutputData on any node that has it.
 *   2. Make Batch Roles drop items with no url or title before building { roles: [...] }.
 *
 * GET              -> dry run (reports what would change and what recent runs actually emitted)
 * POST (or ?dry=false) -> apply
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

const NEW_BATCH_CODE = `const items = $input.all().filter(i => {
  const j = i.json || {};
  return j.url && String(j.title || j.Title || '').trim();
});
if (items.length === 0) return [];
return [{ json: { roles: items.map(i => i.json) } }];`;

const codeOf = (n) => n.parameters?.jsCode || n.parameters?.functionCode || "";

const isBatchNode = (n) =>
  n.type === "n8n-nodes-base.code" && /batch/i.test(n.name) && codeOf(n).includes("roles:");

const batchAlreadyGuarded = (n) => codeOf(n).includes(".filter(");

async function n8n(path, options = {}) {
  return fetch(`${N8N_BASE}/api/v1${path}`, {
    ...options,
    headers: {
      "X-N8N-API-KEY": process.env.N8N_API_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

// Checks what Batch Roles actually emitted in recent successful runs, so we can confirm
// the field names the new filter relies on (url, title) match what each scraper produces.
async function sampleBatchOutput(workflowId, batchName) {
  const listRes = await n8n(`/executions?workflowId=${workflowId}&status=success&limit=5`);
  if (!listRes.ok) return { error: `executions list ${listRes.status}` };
  const list = (await listRes.json()).data || [];
  let emptyRoles = 0;
  let withTitleAndUrl = 0;
  let total = 0;
  const keys = new Set();
  for (const ex of list) {
    const r = await n8n(`/executions/${ex.id}?includeData=true`);
    if (!r.ok) continue;
    const det = await r.json();
    const out = det.data?.resultData?.runData?.[batchName]?.[0]?.data?.main?.[0] || [];
    for (const item of out) {
      for (const role of item.json?.roles || []) {
        total++;
        Object.keys(role).forEach((k) => keys.add(k));
        if (!Object.keys(role).length) emptyRoles++;
        else if (role.url && String(role.title || role.Title || "").trim()) withTitleAndUrl++;
      }
    }
  }
  return {
    executionsChecked: list.length,
    rolesSeen: total,
    emptyRoles,
    rolesPassingNewFilter: withTitleAndUrl,
    fieldNames: [...keys],
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!process.env.N8N_API_KEY) return res.status(500).json({ error: "N8N_API_KEY not set" });

  const dryRun = req.method === "GET" || req.query?.dry === "true";
  const results = [];

  for (const scraper of SCRAPER_IDS) {
    const result = { id: scraper.id, name: scraper.name, active: null, changes: [], status: "unknown" };
    try {
      const wfRes = await n8n(`/workflows/${scraper.id}`);
      if (!wfRes.ok) {
        result.status = `fetch_failed_${wfRes.status}`;
        results.push(result);
        continue;
      }
      const wf = await wfRes.json();
      result.active = wf.active;
      const nodes = wf.nodes || [];

      const batch = nodes.find(isBatchNode);
      if (!batch) {
        result.status = "no_batch_node";
        results.push(result);
        continue;
      }

      const updatedNodes = nodes.map((n) => {
        let out = n;
        if (n.alwaysOutputData === true) {
          result.changes.push(`turn off alwaysOutputData on "${n.name}"`);
          out = { ...out, alwaysOutputData: false };
        }
        if (n.name === batch.name && !batchAlreadyGuarded(n)) {
          result.changes.push(`add url/title filter to "${n.name}"`);
          out = { ...out, parameters: { ...out.parameters, jsCode: NEW_BATCH_CODE } };
        }
        return out;
      });

      result.recentBatchOutput = await sampleBatchOutput(scraper.id, batch.name).catch((e) => ({
        error: e.message,
      }));

      if (!result.changes.length) {
        result.status = "already_fixed";
        results.push(result);
        continue;
      }
      if (dryRun) {
        result.status = "would_fix";
        results.push(result);
        continue;
      }

      const safeSettings = {};
      for (const k of SAFE_SETTING_KEYS) {
        if (wf.settings?.[k] !== undefined) safeSettings[k] = wf.settings[k];
      }
      if (wf.active) await n8n(`/workflows/${scraper.id}/deactivate`, { method: "POST" });
      const putRes = await n8n(`/workflows/${scraper.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: wf.name,
          nodes: updatedNodes,
          connections: wf.connections,
          settings: safeSettings,
        }),
      });
      if (wf.active) await n8n(`/workflows/${scraper.id}/activate`, { method: "POST" });

      result.status = putRes.ok
        ? "fixed"
        : `put_failed: ${(await putRes.text().catch(() => "")).slice(0, 200)}`;
      results.push(result);
    } catch (e) {
      result.status = `error: ${e.message}`;
      results.push(result);
    }
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  return res.status(200).json({
    dryRun,
    summary: `${count(dryRun ? "would_fix" : "fixed")} ${dryRun ? "would be changed" : "fixed"}, ${count("already_fixed")} already fixed, ${results.length - count(dryRun ? "would_fix" : "fixed") - count("already_fixed")} other`,
    results,
  });
}
