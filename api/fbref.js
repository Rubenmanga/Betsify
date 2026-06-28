// FBref match log proxy — xG para selecciones nacionales
// FBref usa Cloudflare; si bloquea desde Vercel, devuelve 503 y app.js lo maneja.
// Estructura HTML de FBref: tabla id="matchlogs_for", celdas con data-stat="xg"/"xga".

const SAFE_SQUAD_ID = /^[a-f0-9]{8}$/;

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function cell(rowHtml, dataStat) {
  const re = new RegExp(`<td[^>]*\\bdata-stat="${dataStat}"[^>]*>([\\s\\S]*?)<\\/td>`);
  const m = rowHtml.match(re);
  return m ? stripTags(m[1]) || null : null;
}

function parseMatchLogs(html) {
  // FBref pone los partidos en id="matchlogs_for"
  const tableM = html.match(/<table[^>]+id="matchlogs_for"[^>]*>([\s\S]*?)<\/table>/);
  if (!tableM) return null; // página de desafío Cloudflare o estructura inesperada

  const tbodyM = tableM[1].match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyM) return [];

  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;

  while ((m = rowRe.exec(tbodyM[1])) !== null) {
    const rowHtml = m[1];
    const date = cell(rowHtml, 'date');
    // Las filas sin fecha válida son separadores o cabeceras internas
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const xgRaw  = cell(rowHtml, 'xg');
    const xgaRaw = cell(rowHtml, 'xga');
    const gfRaw  = cell(rowHtml, 'gf');
    const gaRaw  = cell(rowHtml, 'ga');

    const toNum = v =>
      v != null && v !== '' && v !== '—' && v !== 'N/A' ? parseFloat(v) : null;

    rows.push({
      date,
      comp:     cell(rowHtml, 'comp'),
      opponent: cell(rowHtml, 'opponent'),
      gf:  toNum(gfRaw),
      ga:  toNum(gaRaw),
      xg:  toNum(xgRaw),
      xga: toNum(xgaRaw),
    });
  }

  return rows;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  const teamId = String(req.query.team_id || '').toLowerCase();
  if (!SAFE_SQUAD_ID.test(teamId)) {
    return res.status(400).json({ ok: false, error: 'team_id inválido (8 caracteres hex)' });
  }

  // Delay de cortesía para no saturar FBref
  await new Promise(r => setTimeout(r, 1000));

  const url = `https://fbref.com/en/squads/${teamId}/matchlogs/all_comps/schedule/`;

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (upstream.status === 429) {
      return res
        .status(429)
        .json({ ok: false, error: 'FBref rate limit (429) — intenta en unos minutos' });
    }

    if (!upstream.ok) {
      const err = new Error(`FBref respondió con HTTP ${upstream.status}`);
      err.status = upstream.status;
      throw err;
    }

    const html = await upstream.text();
    const matches = parseMatchLogs(html);

    if (matches === null) {
      return res.status(503).json({
        ok: false,
        error: 'FBref: tabla de partidos no encontrada (posible bloqueo Cloudflare)',
      });
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ ok: true, data: matches });
  } catch (err) {
    const status = err.status && err.status >= 400 ? err.status : 502;
    return res
      .status(status)
      .json({ ok: false, error: err instanceof Error ? err.message : 'Error FBref' });
  }
}
