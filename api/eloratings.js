// National team ELO proxy — eloratings.net
// Returns [{From, To, Elo}] matching ClubElo format so existing eloOnDate() works unchanged.

const NAME_MAP = {
  'United States':        'USA',
  'South Korea':          'Korea Republic',
  'North Korea':          'Korea DPR',
  'DR Congo':             'Congo DR',
  'Republic of Ireland':  'Ireland',
  'Ivory Coast':          'Ivory Coast',
  'Cape Verde':           'Cape Verde',
  'Trinidad & Tobago':    'Trinidad and Tobago',
  'Bosnia & Herzegovina': 'Bosnia-Herzegovina',
};

export default async function handler(req, res) {
  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'team required' });

  const mapped = NAME_MAP[team] || team;
  const urlName = mapped.replace(/ /g, '_');

  try {
    const resp = await fetch(`https://www.eloratings.net/${encodeURIComponent(urlName)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.eloratings.net/',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) return res.status(resp.status).json({ error: 'eloratings.net upstream error' });

    const html = await resp.text();
    const pairs = [];

    // Highcharts Date.UTC format: [Date.UTC(year, month0, day), elo]
    const re1 = /Date\.UTC\((\d{4}),\s*(\d+),\s*(\d+)\),\s*([\d.]+)/g;
    let m;
    while ((m = re1.exec(html)) !== null) {
      const y = +m[1], mo = +m[2] + 1, d = +m[3];
      pairs.push({
        date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        elo: m[4],
      });
    }

    // Fallback: Unix timestamp format: [1609459200000, elo]
    if (!pairs.length) {
      const re2 = /\[(\d{13}),\s*([\d.]+)\]/g;
      while ((m = re2.exec(html)) !== null) {
        pairs.push({ date: new Date(+m[1]).toISOString().slice(0, 10), elo: m[2] });
      }
    }

    if (!pairs.length) return res.status(404).json({ error: 'No ELO data' });

    const today = new Date().toISOString().slice(0, 10);
    const records = pairs.map((p, i) => ({
      From: p.date,
      To:   pairs[i + 1]?.date ?? today,
      Elo:  p.elo,
    }));

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
