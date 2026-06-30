// FBref match log proxy — xG para selecciones nacionales
//
// IMPORTANTE: a diferencia de los clubes, FBref NO tiene una única página
// "/matchlogs/all_comps/schedule/" con el historial completo para selecciones
// nacionales. Cada selección tiene una página por temporada+competición:
//   /en/squads/{id}/{season}/matchlogs/{compId}/schedule/...
// La lista de esas páginas se descubre desde:
//   /en/squads/{id}/history/  (tabla con todas las temporadas jugadas)
//
// Flujo de este proxy:
//   1. Fetch de /en/squads/{id}/history/ → extraer enlaces a matchlogs
//      de las últimas N páginas (param ?pages=, default 8).
//   2. Fetch secuencial (con delay) de cada matchlog encontrado.
//   3. Agregar y deduplicar partidos por fecha+rival.
//
// FBref limita a ~10 requests/min — por eso cacheamos agresivamente
// (Cache-Control) y limitamos el número de páginas a recorrer por defecto.

const SAFE_SQUAD_ID = /^[a-f0-9]{8}$/;
const REQUEST_DELAY_MS = 4000; // con margen real bajo el límite de 10 req/min de FBref
const DEFAULT_PAGE_LIMIT = 8; // ~8 páginas + 1 /history/ = 9 fetches ≈ 35s, bajo maxDuration=60s
const MAX_PAGE_LIMIT = 12;

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
  const re = new RegExp(`<t[hd][^>]*\\bdata-stat="${dataStat}"[^>]*>([\\s\\S]*?)<\\/t[hd]>`);
  const m = rowHtml.match(re);
  return m ? stripTags(m[1]) || null : null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchFBref(url) {
  const upstream = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
    },
    signal: AbortSignal.timeout(15000),
  });
  return upstream;
}

// ── Paso 1: descubrir páginas de matchlog desde /history/ ──────────────────
//
// OJO: una misma temporada puede tener varias páginas (clasificatorias +
// amistosos + Nations League corren en paralelo), así que se indexa por
// season+compId (no solo por season) para no perder competiciones paralelas.
function discoverMatchlogUrls(historyHtml, teamId, pageLimit) {
  const linkRe = new RegExp(
    `href="(/en/squads/${teamId}/([0-9]{4}(?:-[0-9]{4})?)/matchlogs/([a-z0-9_]+)/schedule/[^"]*)"`,
    'g'
  );
  const seen = new Map(); // `${season}|${compId}` -> {path, season}
  let m;
  while ((m = linkRe.exec(historyHtml)) !== null) {
    const [, path, season, compId] = m;
    const key = `${season}|${compId}`;
    if (!seen.has(key)) seen.set(key, { path, season });
  }

  // Ordenar por temporada descendente (más reciente primero); a igualdad de
  // temporada el orden entre competiciones es estable mediante sort estable.
  const entries = [...seen.values()].sort((a, b) => b.season.localeCompare(a.season));
  return entries.slice(0, pageLimit).map(e => 'https://fbref.com' + e.path);
}

// ── Paso 2: parsear una página de matchlog individual ───────────────────────
function parseMatchLogPage(html) {
  const tableM = html.match(/<table[^>]+id="matchlogs_for"[^>]*>([\s\S]*?)<\/table>/);
  if (!tableM) return null;

  const tbodyM = tableM[1].match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyM) return [];

  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;

  while ((m = rowRe.exec(tbodyM[1])) !== null) {
    const rowHtml = m[1];
    const date = cell(rowHtml, 'date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const toNum = v =>
      v != null && v !== '' && v !== '—' && v !== 'N/A' ? parseFloat(v) : null;

    rows.push({
      date,
      comp: cell(rowHtml, 'comp'),
      opponent: cell(rowHtml, 'opponent'),
      venue: cell(rowHtml, 'venue'),
      gf: toNum(cell(rowHtml, 'gf')),
      ga: toNum(cell(rowHtml, 'ga')),
      xg: toNum(cell(rowHtml, 'xg')),
      xga: toNum(cell(rowHtml, 'xga')),
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

  const pageLimit = Math.min(
    MAX_PAGE_LIMIT,
    Math.max(1, parseInt(req.query.pages, 10) || DEFAULT_PAGE_LIMIT)
  );

  try {
    const historyUrl = `https://fbref.com/en/squads/${teamId}/history/`;
    const historyResp = await fetchFBref(historyUrl);

    if (historyResp.status === 429) {
      return res.status(429).json({ ok: false, error: 'FBref rate limit (429) en /history/ — intenta en unos minutos' });
    }
    if (!historyResp.ok) {
      return res.status(historyResp.status >= 400 ? historyResp.status : 502).json({
        ok: false,
        error: `FBref /history/ respondió HTTP ${historyResp.status}`,
      });
    }

    const historyHtml = await historyResp.text();
    const matchlogUrls = discoverMatchlogUrls(historyHtml, teamId, pageLimit);

    if (matchlogUrls.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'No se encontraron páginas de matchlog para este equipo (revisa el team_id)',
      });
    }

    const allMatches = [];
    const errors = [];

    for (let i = 0; i < matchlogUrls.length; i++) {
      if (i > 0) await sleep(REQUEST_DELAY_MS);

      try {
        const resp = await fetchFBref(matchlogUrls[i]);
        if (resp.status === 429) {
          errors.push(`429 en ${matchlogUrls[i]} — deteniendo recorrido temprano`);
          break;
        }
        if (!resp.ok) {
          errors.push(`HTTP ${resp.status} en ${matchlogUrls[i]}`);
          continue;
        }
        const html = await resp.text();
        const rows = parseMatchLogPage(html);
        if (rows === null) {
          errors.push(`Tabla no encontrada en ${matchlogUrls[i]}`);
          continue;
        }
        allMatches.push(...rows);
      } catch (e) {
        errors.push(`Error en ${matchlogUrls[i]}: ${e instanceof Error ? e.message : 'fetch failed'}`);
      }
    }

    const dedup = new Map();
    for (const match of allMatches) {
      const key = `${match.date}|${match.opponent}`;
      if (!dedup.has(key)) dedup.set(key, match);
    }
    const matches = [...dedup.values()].sort((a, b) => a.date.localeCompare(b.date));

    if (matches.length === 0) {
      return res.status(502).json({
        ok: false,
        error: 'No se pudo extraer ningún partido de FBref',
        details: errors,
      });
    }

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json({
      ok: true,
      data: matches,
      meta: {
        pagesRequested: pageLimit,
        pagesFound: matchlogUrls.length,
        matchCount: matches.length,
        errors: errors.length ? errors : undefined,
      },
    });
  } catch (err) {
    const status = err.status && err.status >= 400 ? err.status : 502;
    return res.status(status).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Error FBref',
    });
  }
}