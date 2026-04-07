const N8N_BASE = "https://n8n-production-97a9.up.railway.app";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'N8N_API_KEY not set in Vercel environment variables' });
  }

  const { workflowId, active } = req.body || {};
  if (!workflowId) return res.status(400).json({ error: 'workflowId is required' });
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) is required' });

  const action = active ? 'activate' : 'deactivate';

  try {
    const response = await fetch(`${N8N_BASE}/api/v1/workflows/${workflowId}/${action}`, {
      method: 'POST',
      headers: {
        'X-N8N-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      let errMsg = `n8n returned ${response.status}`;
      try {
        const errBody = await response.json();
        errMsg = errBody.message || errBody.error || errMsg;
      } catch {}
      return res.status(response.status).json({ error: errMsg });
    }

    return res.status(200).json({ success: true, workflowId, active });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
