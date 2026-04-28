const N8N_BASE = "https://n8n-production-97a9.up.railway.app";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "N8N_API_KEY not set" });

  const h = { "X-N8N-API-KEY": apiKey, "Content-Type": "application/json" };

  try {
    // Get recent executions (last 20)
    const execRes = await fetch(`${N8N_BASE}/api/v1/executions?limit=20&status=error`, { headers: h });
    const execData = await execRes.json();

    if (!execRes.ok) {
      return res.status(500).json({ error: "n8n executions fetch failed", status: execRes.status, body: execData });
    }

    // For each execution, get the error detail
    const executions = execData.data || [];
    const details = await Promise.all(
      executions.slice(0, 8).map(async (ex) => {
        try {
          const detailRes = await fetch(`${N8N_BASE}/api/v1/executions/${ex.id}`, { headers: h });
          const detail = await detailRes.json();

          // Find the first node with an error
          const data = detail.data?.resultData?.runData || {};
          const errorNode = Object.entries(data).find(([, v]) =>
            Array.isArray(v) && v.some(run => run.error)
          );
          const errorInfo = errorNode
            ? {
                node: errorNode[0],
                error: errorNode[1].find(r => r.error)?.error,
              }
            : null;

          return {
            id: ex.id,
            workflowName: ex.workflowData?.name || ex.workflowId,
            startedAt: ex.startedAt,
            errorNode: errorInfo?.node,
            errorMessage: errorInfo?.error?.message || errorInfo?.error?.description || "unknown",
            errorType: errorInfo?.error?.name,
          };
        } catch (e) {
          return { id: ex.id, fetchError: e.message };
        }
      })
    );

    return res.status(200).json({ ok: true, count: executions.length, details });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
