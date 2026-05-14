/**
 * Diagnoses and fixes scrapers that push blank/untitled jobs to Airtable.
 *
 * Problem: One or more scrapers emit items that have a URL but no title,
 * which pass the existing URL-only DeDupe filter and land in Airtable as
 * blank rows visible in the Sortable kanban view.
 *
 * Fix: Inject a title guard into each DeDupe code node so that items with
 * a blank title (regardless of URL) are dropped before reaching Airtable.
 *
 * GET  → dry-run: report which workflows need the fix
 * POST → apply: inject the title guard into all DeDupe nodes that lack it
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

// Matches the batch DeDupe node produced by fix-dedup (uses existingUrls Set)
function isBatchDedupeNode(node) {
  if (node.type !== "n8n-nodes-base.code") return false;
  const code = node.parameters?.jsCode || node.parameters?.functionCode || "";
  return code.includes("existingUrls") && code.includes("airtable.com");
}

// Returns true if the DeDupe code already guards against blank titles
function hasTitleGuard(code) {
  return (
    code.includes("title.trim()") ||
    code.includes("!title ||") ||
    code.includes("|| !title") ||
    (code.includes("title") && code.includes("!url || !title"))
  );
}

// Adds a title guard to the DeDupe loop, preserving the original indentation.
// Replaces:   const url = item.json.url;\n<indent>if (!url) continue;
// With:       const url = item.json.url;\n<indent>const title = ...\n<indent>if (!url || !title.trim()) continue;
function injectTitleGuard(code) {
  return code.replace(
    /const url = item\.json\.url;\s*\n(\s*)if \(!url\) continue;/,
    (_, indent) =>
      `const url = item.json.url;\n` +
      `${indent}const title = item.json.title || item.json.Title || item.json.name || item.json.jobTitle || "";\n` +
      `${indent}if (!url || !title.trim()) continue;`
  );
}

// Scans non-DeDupe code nodes for ones that produce job-shaped items.
// Returns a lightweight report to help identify the culprit scraper.
function analyzeScraperNodes(nodes) {
  return nodes
    .filter((n) => n.type === "n8n-nodes-base.code")
    .map((n) => {
      const code = n.parameters?.jsCode || n.parameters?.functionCode || "";
      if (!code || code.includes("existingUrls")) return null; // skip DeDupe

      const producesItems =
        (code.includes("url") || code.includes("URL")) &&
        (code.includes("title") || code.includes("Title") ||
          code.includes("name") || code.includes("Name"));
      if (!producesItems) return null;

      // A title guard means the code explicitly drops blank-title items
      const guardPatterns = [
        "if (!title",
        "if (!name",
        "!title.trim()",
        ".filter(",
        "continue",
      ];
      const hasGuard = guardPatterns.some((p) => code.includes(p));

      return {
        nodeName: n.name,
        hasItemGuard: hasGuard,
        // First 400 chars of the output-building section for manual review
        codeSnippet: code.slice(0, 400),
      };
    })
    .filter(Boolean);
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "N8N_API_KEY not set" });

  const dryRun = req.method === "GET" || req.query?.dry === "true";
  const results = [];

  for (const scraper of SCRAPER_IDS) {
    const result = {
      id: scraper.id,
      name: scraper.name,
      dedupeFound: false,
      dedupeHasTitleGuard: false,
      dedupeNodeName: null,
      suspiciousNodes: [],   // scraper nodes that produce items without a title guard
      status: "unknown",
    };

    try {
      const wfRes = await n8nFetch(`/workflows/${scraper.id}`);
      if (!wfRes.ok) {
        result.status = `fetch_failed_${wfRes.status}`;
        results.push(result);
        continue;
      }
      const wf = await wfRes.json();

      // 1. Find the DeDupe node
      const dedupeNode = (wf.nodes || []).find(isBatchDedupeNode);

      if (!dedupeNode) {
        result.status = "no_batch_dedupe_node";
        // Still report scraper node analysis
        result.suspiciousNodes = analyzeScraperNodes(wf.nodes || []);
        // Show all code nodes for debugging
        result.allCodeNodes = (wf.nodes || [])
          .filter((n) => n.type === "n8n-nodes-base.code")
          .map((n) => ({
            name: n.name,
            snippet: (n.parameters?.jsCode || n.parameters?.functionCode || "").slice(0, 150),
          }));
        results.push(result);
        continue;
      }

      const existingCode = dedupeNode.parameters?.jsCode || dedupeNode.parameters?.functionCode || "";
      result.dedupeFound = true;
      result.dedupeNodeName = dedupeNode.name;
      result.dedupeHasTitleGuard = hasTitleGuard(existingCode);

      // 2. Analyse scraper nodes for blank-title risk
      result.suspiciousNodes = analyzeScraperNodes(wf.nodes || []).filter(
        (n) => !n.hasItemGuard
      );

      if (result.dedupeHasTitleGuard) {
        result.status = "already_fixed";
        results.push(result);
        continue;
      }

      if (dryRun) {
        result.status = "needs_fix";
        result.newCodePreview =
          injectTitleGuard(existingCode).slice(0, 200) + "…";
        results.push(result);
        continue;
      }

      // 3. Apply fix: inject title guard into DeDupe node
      const newCode = injectTitleGuard(existingCode);

      if (newCode === existingCode) {
        // Regex didn't match — code structure differs from expected
        result.status = "inject_failed_pattern_mismatch";
        result.dedupeSnippet = existingCode.slice(0, 300);
        results.push(result);
        continue;
      }

      const updatedNodes = wf.nodes.map((n) =>
        n.name === dedupeNode.name
          ? { ...n, parameters: { ...n.parameters, jsCode: newCode } }
          : n
      );

      const safeSettings = {};
      for (const k of SAFE_SETTING_KEYS) {
        if (wf.settings?.[k] !== undefined) safeSettings[k] = wf.settings[k];
      }

      // Deactivate → PUT → reactivate
      await n8nFetch(`/workflows/${scraper.id}/deactivate`, { method: "POST" });

      const putRes = await n8nFetch(`/workflows/${scraper.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: wf.name,
          nodes: updatedNodes,
          connections: wf.connections,
          settings: safeSettings,
        }),
      });

      if (!putRes.ok) {
        const errText = await putRes.text().catch(() => "");
        result.status = `put_failed: ${errText.slice(0, 200)}`;
        await n8nFetch(`/workflows/${scraper.id}/activate`, { method: "POST" });
        results.push(result);
        continue;
      }

      if (wf.active) {
        await n8nFetch(`/workflows/${scraper.id}/activate`, { method: "POST" });
      }

      result.status = "fixed";
      results.push(result);
    } catch (e) {
      result.status = `error: ${e.message}`;
      results.push(result);
    }
  }

  const needsFix    = results.filter((r) => r.status === "needs_fix").length;
  const fixed       = results.filter((r) => r.status === "fixed").length;
  const alreadyOk   = results.filter((r) => r.status === "already_fixed").length;
  const suspicious  = results.filter((r) => r.suspiciousNodes?.length > 0);

  return res.status(200).json({
    dryRun,
    summary: dryRun
      ? `${needsFix} workflow(s) need the title guard; ${alreadyOk} already fixed`
      : `${fixed} fixed, ${alreadyOk} already had the guard`,
    // Surface the most likely culprits upfront
    likelyCulprits: suspicious.map((r) => ({
      name: r.name,
      suspiciousNodes: r.suspiciousNodes,
    })),
    results,
  });
}
