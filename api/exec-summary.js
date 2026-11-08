// Temporary read-only diagnostic: counts n8n executions per workflow per day. Not for production.
const N8N_BASE = "https://n8n-production-97a9.up.railway.app";
const DAYS = 45;
const MAX_PAGES = 60;

async function n8n(path) {
  const r = await fetch(`${N8N_BASE}/api/v1${path}`, { headers: { "X-N8N-API-KEY": process.env.N8N_API_KEY } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  if (!process.env.N8N_API_KEY) return res.status(500).json({ error: "N8N_API_KEY not set" });
  try {
    const wfs = await n8n("/workflows?limit=250");
    const names = Object.fromEntries((wfs.data || []).map((w) => [w.id, w.name]));
    const cutoff = Date.now() - DAYS * 86400000;

    const perDay = {};
    const perWf = {};
    const perMode = {};
    const longest = [];
    let total = 0, pages = 0, cursor = "", reachedCutoff = false, oldest = null;

    while (pages < MAX_PAGES) {
      const page = await n8n(`/executions?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      pages++;
      const rows = page.data || [];
      for (const e of rows) {
        const t = Date.parse(e.startedAt);
        if (t < cutoff) { reachedCutoff = true; continue; }
        oldest = !oldest || e.startedAt < oldest ? e.startedAt : oldest;
        total++;
        const day = e.startedAt.slice(0, 10);
        const name = names[e.workflowId] || e.workflowId;
        const dur = e.stoppedAt ? (Date.parse(e.stoppedAt) - t) / 1000 : null;

        perDay[day] = (perDay[day] || 0) + 1;
        const w = (perWf[name] ||= { runs: 0, errors: 0, totalSec: 0, maxSec: 0, byDay: {} });
        w.runs++;
        if (e.status === "error" || e.status === "crashed") w.errors++;
        if (dur != null) { w.totalSec += dur; w.maxSec = Math.max(w.maxSec, dur); }
        w.byDay[day] = (w.byDay[day] || 0) + 1;
        perMode[e.mode] = (perMode[e.mode] || 0) + 1;
        if (dur != null) longest.push({ id: e.id, workflow: name, startedAt: e.startedAt, sec: Math.round(dur), status: e.status, mode: e.mode });
      }
      cursor = page.nextCursor;
      if (!cursor || reachedCutoff) break;
    }

    longest.sort((a, b) => b.sec - a.sec);
    const workflows = Object.entries(perWf)
      .map(([name, w]) => ({ name, runs: w.runs, errors: w.errors, avgSec: Math.round(w.totalSec / w.runs), maxSec: Math.round(w.maxSec), totalMin: Math.round(w.totalSec / 60), byDay: w.byDay }))
      .sort((a, b) => b.runs - a.runs);

    return res.status(200).json({
      daysRequested: DAYS, pagesRead: pages, hitPageCap: pages >= MAX_PAGES, reachedCutoff,
      oldestExecutionSeen: oldest, totalExecutions: total,
      perDay: Object.fromEntries(Object.entries(perDay).sort()),
      perMode, workflows, longest: longest.slice(0, 10),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
