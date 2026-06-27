const BASE = 'https://api.sofascore.com/api/v1';
const SAFE_NUM = /^\d+$/;
const SAFE_Q   = /^[a-zA-ZÀ-ÿ0-9 '\-\.]+$/;

async function sfFetch(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'application/json',
      'Referer': 'https://www.sofascore.com/'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) { const e = new Error(`Sofascore ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Método no permitido' });
  const { mode } = req.query;
  try {
    let data;
    if (mode === 'search') {
      const q = String(req.query.q || '').trim();
      if (!q || !SAFE_Q.test(q)) throw new Error('Nombre no válido');
      data = await sfFetch(`${BASE}/search?q=${encodeURIComponent(q)}&t=1`);
    } else if (mode === 'events') {
      const tid = String(req.query.team_id || '');
      if (!SAFE_NUM.test(tid)) throw new Error('ID de equipo no válido');
      data = await sfFetch(`${BASE}/team/${tid}/events/last/0`);
    } else if (mode === 'stats') {
      const eid = String(req.query.event_id || '');
      if (!SAFE_NUM.test(eid)) throw new Error('ID de evento no válido');
      data = await sfFetch(`${BASE}/event/${eid}/statistics`);
    } else {
      return res.status(400).json({ ok: false, error: 'Modo no permitido' });
    }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ ok: true, data });
  } catch (err) {
    return res.status(err.status >= 400 ? err.status : 502).json({
      ok: false, error: err instanceof Error ? err.message : 'Error Sofascore'
    });
  }
}
