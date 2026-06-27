const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

const SAFE_LEAGUE = /^[a-z0-9.\-]+$/i;
const SAFE_ID = /^[a-z0-9_-]+$/i;

async function fetchJson(url) {
  const upstream = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Betsify/1.0 personal analytics'
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!upstream.ok) {
    const error = new Error(`ESPN respondió con HTTP ${upstream.status}`);
    error.status = upstream.status;
    throw error;
  }

  return upstream.json();
}

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  const { mode } = request.query;

  try {
    let payload;

    if (mode === 'scoreboard') {
      const league = String(request.query.league || 'fifa.world');
      const date = String(request.query.date || '').replace(/[^0-9]/g, '');
      if (!SAFE_LEAGUE.test(league)) throw new Error('Liga no válida');
      const suffix = date ? `?dates=${date}` : '';
      payload = await fetchJson(`${BASE}/${league}/scoreboard${suffix}`);
    } else if (mode === 'schedule') {
      const team = String(request.query.team || '');
      const season = String(request.query.season || new Date().getUTCFullYear());
      if (!SAFE_ID.test(team)) throw new Error('Equipo no válido');
      if (!/^\d{4}$/.test(season)) throw new Error('Temporada no válida');
      payload = await fetchJson(`${BASE}/all/teams/${team}/schedule?season=${season}`);
    } else if (mode === 'summary') {
      const event = String(request.query.event || '');
      const requestedLeague = String(request.query.league || '');
      if (!SAFE_ID.test(event)) throw new Error('Evento no válido');
      if (requestedLeague && !SAFE_LEAGUE.test(requestedLeague)) throw new Error('Liga no válida');

      const candidates = [...new Set([
        requestedLeague,
        'all',
        'fifa.world',
        'fifa.friendly',
        'fifa.worldq.uefa',
        'fifa.worldq.caf',
        'fifa.worldq.concacaf',
        'fifa.worldq.conmebol',
        'fifa.worldq.afc',
        'uefa.nations',
        'uefa.euro',
        'concacaf.gold',
        'conmebol.america',
        'caf.nations',
        'afc.asian.cup'
      ].filter(Boolean))];

      let lastError;
      for (const league of candidates) {
        try {
          payload = await fetchJson(`${BASE}/${league}/summary?event=${event}`);
          if (payload && (payload.header || payload.boxscore || payload.gameInfo)) {
            payload.__betsifyLeague = league;
            break;
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (!payload) throw lastError || new Error('No se encontró el resumen del partido');
    } else {
      return response.status(400).json({ ok: false, error: 'Modo no permitido' });
    }

    response.setHeader('Cache-Control', mode === 'summary' ? 's-maxage=86400, stale-while-revalidate=604800' : 's-maxage=300, stale-while-revalidate=900');
    return response.status(200).json({ ok: true, data: payload });
  } catch (error) {
    return response.status(error.status && error.status >= 400 ? error.status : 502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo consultar ESPN'
    });
  }
}
