const N8N_BASE = "https://n8n-production-97a9.up.railway.app";
const AIRTABLE_BASE = "appExecJobSearch"; // placeholder — override via ?base=xxx

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Quick test: can we hit the get-roles webhook directly?
  const webhookTest = await fetch(`${N8N_BASE}/webhook/get-roles`, { signal: AbortSignal.timeout(8000) })
    .then(async r => ({ status: r.status, ok: r.ok, body: (await r.text()).slice(0, 300) }))
    .catch(e => ({ error: e.message }));

  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "N8N_API_KEY not set" });

  const h = { "X-N8N-API-KEY": apiKey, "Content-Type": "application/json" };

  try {
    // Also check a key workflow (Boyden) for its node/credential structure
    const boydenRes = await fetch(`${N8N_BASE}/api/v1/workflows/uM7rHp7yPmIavmzH`, { headers: h });
    const boyden = await boydenRes.json();
    const boydenCredentials = (boyden.nodes || [])
      .flatMap(n => Object.values(n.credentials || {}))
      .map(c => ({ id: c.id, name: c.name }));
    const boydenNodeTypes = (boyden.nodes || []).map(n => ({ name: n.name, type: n.type }));

    // Get recent executions (last 20)
    const execRes = await fetch(`${N8N_BASE}/api/v1/executions?limit=20&status=error`, { headers: h });
    const execData = await execRes.json();

    if (!execRes.ok) {
      return res.status(500).json({ error: "n8n executions fetch failed", status: execRes.status, body: execData });
    }

    // RAW: dump first execution's detail structure for debugging
    const firstId = (execData.data || [])[0]?.id;
    let rawSample = null;
    if (firstId) {
      const r = await fetch(`${N8N_BASE}/api/v1/executions/${firstId}?includeData=true`, { headers: h });
      const raw = await r.json();
      // Show top-level keys and a slice of the data
      rawSample = {
        topKeys: Object.keys(raw),
        id: raw.id,
        workflowId: raw.workflowId,
        workflowName: raw.workflowData?.name,
        status: raw.status,
        stoppedAt: raw.stoppedAt,
        dataKeys: raw.data ? Object.keys(raw.data) : [],
        resultDataKeys: raw.data?.resultData ? Object.keys(raw.data.resultData) : [],
        runDataKeys: raw.data?.resultData?.runData ? Object.keys(raw.data.resultData.runData) : [],
        errorSample: JSON.stringify(raw.data?.resultData?.error || raw.data?.data?.resultData?.error || "none").slice(0, 500),
        // Try to get last node error
        lastNodeError: (() => {
          const rd = raw.data?.resultData?.runData || {};
          for (const [node, runs] of Object.entries(rd)) {
            if (Array.isArray(runs)) for (const run of runs) if (run.error) return { node, err: JSON.stringify(run.error).slice(0,400) };
          }
          return null;
        })(),
        rawSnippet: JSON.stringify(raw).slice(0, 1000),
      };
    }

    // For each unique workflow, get one execution detail
    const executions = execData.data || [];
    const seen = new Set();
    const unique = executions.filter(ex => {
      const key = ex.workflowId || ex.workflowData?.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const details = await Promise.all(
      unique.slice(0, 10).map(async (ex) => {
        try {
          const detailRes = await fetch(`${N8N_BASE}/api/v1/executions/${ex.id}?includeData=true&includeData=true`, { headers: h });
          const detail = await detailRes.json();

          const runData = detail.data?.resultData?.runData || detail.data?.data?.resultData?.runData || {};

          // Find nodes with errors
          let errorNode = null, errorMessage = "unknown", errorType = "";
          for (const [nodeName, runs] of Object.entries(runData)) {
            if (!Array.isArray(runs)) continue;
            for (const run of runs) {
              if (run.error) {
                errorNode = nodeName;
                errorMessage = run.error.message || run.error.description || run.error.name || JSON.stringify(run.error).slice(0, 200);
                errorType = run.error.name || run.error.type || "";
                break;
              }
            }
            if (errorNode) break;
          }

          // Also check top-level error
          const topErr = detail.data?.resultData?.error || detail.data?.data?.resultData?.error;
          if (!errorNode && topErr) {
            errorMessage = topErr.message || JSON.stringify(topErr).slice(0, 200);
          }

          return {
            id: ex.id,
            workflowId: ex.workflowId || detail.workflowId,
            workflowName: detail.workflowData?.name || ex.workflowData?.name || ex.workflowId,
            startedAt: ex.startedAt,
            errorNode,
            errorMessage,
            errorType,
            rawDataKeys: Object.keys(runData),
          };
        } catch (e) {
          return { id: ex.id, fetchError: e.message };
        }
      })
    );

    return res.status(200).json({
      ok: true,
      webhookTest,
      boydenCredentials,
      boydenNodeTypes,
      count: executions.length,
      rawSample,
      details,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
