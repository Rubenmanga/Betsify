export default async function handler(req, res) {
  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'team required' });

  try {
    const resp = await fetch(`https://api.clubelo.com/${encodeURIComponent(team)}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'text/plain,text/csv' }
    });
    if (!resp.ok) return res.status(resp.status).json({ error: 'ClubElo upstream error' });

    const text = await resp.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return res.status(404).json({ error: 'No data' });

    const headers = lines[0].split(',').map(h => h.trim());
    const records = lines.slice(1).map(line => {
      const vals = line.split(',');
      return Object.fromEntries(headers.map((h, i) => [h, vals[i]?.trim() ?? '']));
    });

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
