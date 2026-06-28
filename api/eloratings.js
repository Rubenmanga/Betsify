// Proxy → World Football Elo Ratings (eloratings.net)
// Fetches per-team historical TSV and returns [{From, To, Elo}] compatible with eloOnDate().
// TSV columns: year  month  day  home_code  away_code  home_goals  away_goals  tournament_type
//              tournament_name  elo_change  home_elo_after  away_elo_after  ...

const SAFE_NAME = /^[a-zA-Z0-9 _'.'-]+$/;

function detectTeamCode(lines) {
  const freq = new Map();
  let validRows = 0;
  for (const line of lines) {
    const p = line.split('\t');
    if (p.length < 5) continue;
    freq.set(p[3], (freq.get(p[3]) || 0) + 1);
    freq.set(p[4], (freq.get(p[4]) || 0) + 1);
    validRows++;
  }
  let best = null, bestN = 0;
  for (const [code, n] of freq) {
    if (n > bestN) { bestN = n; best = code; }
  }
  // Team code appears in every row (pos 3 or 4), opponents appear far less
  return validRows > 0 && bestN >= validRows * 0.9 ? best : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'team required' });

  const safeName = String(team).trim();
  if (!SAFE_NAME.test(safeName)) return res.status(400).json({ error: 'Invalid team name' });

  const urlName = safeName.replace(/ /g, '_');

  try {
    const resp = await fetch(`https://eloratings.net/${encodeURIComponent(urlName)}.tsv`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Betsify/1.0 analytics)',
        'Accept': 'text/plain, text/tab-separated-values, */*'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `eloratings upstream: ${resp.status}` });
    }

    const text = await resp.text();
    // Detect HTML error pages (404 served as 200 by some CDNs)
    if (!text || text.trimStart().startsWith('<!')) {
      return res.status(404).json({ error: 'Team not found on eloratings.net' });
    }

    const lines = text.trim().split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return res.status(404).json({ error: 'No data' });

    const teamCode = detectTeamCode(lines);
    if (!teamCode) return res.status(500).json({ error: 'Could not detect team code in TSV' });

    const points = [];
    for (const line of lines) {
      const p = line.split('\t');
      if (p.length < 12) continue;

      const year  = p[0]?.trim();
      const month = p[1]?.trim();
      const day   = p[2]?.trim();
      const home  = p[3]?.trim();
      const away  = p[4]?.trim();

      if (!year || !/^\d{4}$/.test(year)) continue;
      // Skip rows with unknown month/day (stored as 00)
      if (!month || !day || month === '00' || day === '00') continue;

      const isHome = home === teamCode;
      const isAway = away === teamCode;
      if (!isHome && !isAway) continue;

      const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      // home_elo_after = p[10], away_elo_after = p[11]
      const eloStr = (isHome ? p[10] : p[11])?.trim();
      const elo = parseFloat(eloStr);
      if (!isNaN(elo) && elo > 0) {
        points.push({ date, elo: Math.round(elo) });
      }
    }

    if (points.length === 0) return res.status(404).json({ error: 'No valid Elo records found' });

    // Convert to {From, To, Elo} format compatible with existing eloOnDate()
    const records = points.map((p, i) => ({
      From: p.date,
      To:   points[i + 1] ? points[i + 1].date : '2099-12-31',
      Elo:  String(p.elo)
    }));

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json(records);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch eloratings.net' });
  }
}
