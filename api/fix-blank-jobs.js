/**
 * Stops scrapers pushing blank/untitled rows to the Google Sheet.
 *
 * Each scraper's DeDupe code node drops items with no URL but lets through
 * items that have a URL and no title. This adds a title check to those nodes
 * and reports which scraper produced blank items in recent executions.
 *
 * GET              -> dry run: report DeDupe/save nodes, guard status, blank items seen in recent runs
 * POST (or ?dry=false) -> apply the title guard to every DeDupe node missing it
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

const codeOf = (n) => n.parameters?.jsCode || n.parameters?.functionCode || "";

function isDedupeNode(n) {
  if (n.type !== "n8n-nodes-base.code") return false;
  const code = codeOf(n);
  return code.includes("existingUrls") && code.includes("action=getUrls");
}

function hasTitleGuard(code) {
  return /\.trim\(\)\s*\)\s*continue/.test(code) || code.includes("// title guard");
}

const GUARD_RE = /(const url = item\.json\.url;[ \t]*\n)([ \t]*)if \(!url\) continue;/;

function injectTitleGuard(code) {
  return code.replace(
    GUARD_RE,
    (_, head, indent) =>
      `${head}${indent}// title guard: skip untitled items\n` +
      `${indent}const title = String(item.json.title || item.json.Title || '').trim();\n` +
      `${indent}if (!url || !title) continue;`
  );
}

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

// Looks at recent successful runs for items leaving a node with a url but no title.
async function findBlankItems(workflowId) {
  const listRes = await n8n(`/executions?workflowId=${workflowId}&status=success&limit=3`);
  if (!listRes.ok) return { error: `executions list ${listRes.status}` };
  const list = (await listRes.json()).data || [];
  const hits = [];
  for (const ex of list) {
    const detRes = await n8n(`/executions/${ex.id}?includeData=true`);
    if (!detRes.ok) continue;
    const det = await detRes.json();
    const runData = det.data?.resultData?.runData || {};
    for (const [node, runs] of Object.entries(runData)) {
      for (const run of runs || []) {
        for (const item of run.data?.main?.[0] || []) {
          const j = item.json || {};
          if (j.url && !String(j.title || j.Title || "").trim()) {
            hits.push({ executionId: ex.id, node, url: j.url, fields: Object.keys(j) });
          }
        }
      }
    }
  }
  return { executionsChecked: list.length, blankItems: hits.slice(0, 10) };
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
    const result = { id: scraper.id, name: scraper.name, status: "unknown" };
    try {
      const wfRes = await n8n(`/workflows/${scraper.id}`);
      if (!wfRes.ok) {
        result.status = `fetch_failed_${wfRes.status}`;
        results.push(result);
        continue;
      }
      const wf = await wfRes.json();
      const nodes = wf.nodes || [];

      result.saveNodes = nodes
        .filter((n) => JSON.stringify(n.parameters || {}).includes("script.google.com"))
        .map((n) => ({ name: n.name, type: n.type.split(".").pop() }));

      const dedupe = nodes.find(isDedupeNode);
      if (!dedupe) {
        result.status = "no_sheets_dedupe_node";
        result.codeNodes = nodes
          .filter((n) => n.type === "n8n-nodes-base.code")
          .map((n) => ({ name: n.name, snippet: codeOf(n).slice(0, 200) }));
        results.push(result);
        continue;
      }

      const code = codeOf(dedupe);
      result.dedupeNode = dedupe.name;
      result.hasTitleGuard = hasTitleGuard(code);
      result.blankItemsSeen = await findBlankItems(scraper.id).catch((e) => ({ error: e.message }));

      if (result.hasTitleGuard) {
        result.status = "already_guarded";
        results.push(result);
        continue;
      }

      const newCode = injectTitleGuard(code);
      if (newCode === code) {
        result.status = "pattern_mismatch";
        result.dedupeSnippet = code.slice(-300);
        results.push(result);
        continue;
      }

      if (dryRun) {
        result.status = "needs_fix";
        results.push(result);
        continue;
      }

      const safeSettings = {};
      for (const k of SAFE_SETTING_KEYS) {
        if (wf.settings?.[k] !== undefined) safeSettings[k] = wf.settings[k];
      }
      const updatedNodes = nodes.map((n) =>
        n.name === dedupe.name ? { ...n, parameters: { ...n.parameters, jsCode: newCode } } : n
      );

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

      if (!putRes.ok) {
        result.status = `put_failed: ${(await putRes.text().catch(() => "")).slice(0, 200)}`;
      } else {
        result.status = "fixed";
      }
      results.push(result);
    } catch (e) {
      result.status = `error: ${e.message}`;
      results.push(result);
    }
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  return res.status(200).json({
    dryRun,
    summary: dryRun
      ? `${count("needs_fix")} need the guard, ${count("already_guarded")} already guarded, ${count("no_sheets_dedupe_node") + count("pattern_mismatch")} need manual review`
      : `${count("fixed")} fixed, ${count("already_guarded")} already guarded, ${count("no_sheets_dedupe_node") + count("pattern_mismatch")} need manual review`,
    culprits: results
      .filter((r) => r.blankItemsSeen?.blankItems?.length)
      .map((r) => ({ name: r.name, blankItems: r.blankItemsSeen.blankItems })),
    results,
  });
}
