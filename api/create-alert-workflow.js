const N8N_BASE = "https://n8n-production-97a9.up.railway.app";
const VERCEL_URL = "https://executive-job-search.vercel.app";
const GET_ROLES_URL = `${N8N_BASE}/webhook/get-roles`;
const SEND_ALERT_URL = `${VERCEL_URL}/api/send-alert`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "N8N_API_KEY not set" });

  const { alertEmail, enabled = true } = req.body || {};

  const headers = {
    "X-N8N-API-KEY": apiKey,
    "Content-Type": "application/json",
  };

  // Check if the workflow already exists
  const listRes = await fetch(`${N8N_BASE}/api/v1/workflows?limit=50`, { headers });
  const listData = await listRes.json();
  const existing = (listData.data || []).find((w) => w.name === "Job Alert Email");

  const filterCode = `
const today = new Date().toISOString().split('T')[0];
const items = $input.all();
const roles = items.map(i => i.json).filter(r => r.Status === 'New' && r.FetchedDate === today);
return [{ json: { count: roles.length, roles } }];
  `.trim();

  const alertEmail_ = alertEmail || process.env.ALERT_EMAIL || "";

  const workflowBody = {
    name: "Job Alert Email",
    nodes: [
      {
        id: "node_schedule",
        name: "Daily Schedule",
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1.1,
        position: [0, 200],
        parameters: {
          rule: {
            interval: [{ field: "cronExpression", expression: "10 15 * * *" }],
          },
        },
      },
      {
        id: "node_get_roles",
        name: "Get All Roles",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4.1,
        position: [220, 200],
        parameters: {
          url: GET_ROLES_URL,
          method: "GET",
          options: {},
        },
      },
      {
        id: "node_filter",
        name: "Filter New Today",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [440, 200],
        parameters: { jsCode: filterCode },
      },
      {
        id: "node_if",
        name: "Any New Roles?",
        type: "n8n-nodes-base.if",
        typeVersion: 1,
        position: [660, 200],
        parameters: {
          conditions: {
            number: [
              {
                value1: "={{ $json.count }}",
                operation: "larger",
                value2: 0,
              },
            ],
          },
        },
      },
      {
        id: "node_send",
        name: "Send Email Alert",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4.1,
        position: [880, 140],
        parameters: {
          url: SEND_ALERT_URL,
          method: "POST",
          sendHeaders: true,
          headerParameters: {
            parameters: [{ name: "Content-Type", value: "application/json" }],
          },
          sendBody: true,
          contentType: "raw",
          rawContentType: "application/json",
          body: `={{ JSON.stringify({ roles: $json.roles, to: "${alertEmail_}" }) }}`,
          options: {},
        },
      },
    ],
    connections: {
      "Daily Schedule": {
        main: [[{ node: "Get All Roles", type: "main", index: 0 }]],
      },
      "Get All Roles": {
        main: [[{ node: "Filter New Today", type: "main", index: 0 }]],
      },
      "Filter New Today": {
        main: [[{ node: "Any New Roles?", type: "main", index: 0 }]],
      },
      "Any New Roles?": {
        main: [
          [{ node: "Send Email Alert", type: "main", index: 0 }],
          [],
        ],
      },
    },
    settings: { executionOrder: "v1" },
  };

  try {
    let workflowId;

    if (existing) {
      // Deactivate → update → reactivate
      await fetch(`${N8N_BASE}/api/v1/workflows/${existing.id}/deactivate`, {
        method: "POST",
        headers,
      });

      const putRes = await fetch(`${N8N_BASE}/api/v1/workflows/${existing.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(workflowBody),
      });
      if (!putRes.ok) {
        const err = await putRes.text();
        return res.status(500).json({ error: `PUT failed: ${err}` });
      }
      workflowId = existing.id;
    } else {
      // Create new
      const createRes = await fetch(`${N8N_BASE}/api/v1/workflows`, {
        method: "POST",
        headers,
        body: JSON.stringify(workflowBody),
      });
      if (!createRes.ok) {
        const err = await createRes.text();
        return res.status(500).json({ error: `Create failed: ${err}` });
      }
      const created = await createRes.json();
      workflowId = created.id;
    }

    // Activate or deactivate based on `enabled`
    const action = enabled ? "activate" : "deactivate";
    await fetch(`${N8N_BASE}/api/v1/workflows/${workflowId}/${action}`, {
      method: "POST",
      headers,
    });

    return res.status(200).json({
      success: true,
      workflowId,
      created: !existing,
      enabled,
      alertEmail: alertEmail_,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
