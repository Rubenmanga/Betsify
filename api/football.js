const ALLOWED_ENDPOINTS = new Set([
  'status',
  'fixtures',
  'fixtures/statistics',
  'teams',
  'teams/statistics',
  'predictions',
  'odds'
]);

function extractApiError(payload, status) {
  const errors = payload?.errors;
  if (Array.isArray(errors) && errors.length) return errors.join(', ');
  if (errors && typeof errors === 'object' && Object.keys(errors).length) {
    return Object.values(errors).join(', ');
  }
  return `API-Football respondió con HTTP ${status}`;
}

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  const { endpoint, ...parameters } = request.query;
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return response.status(400).json({ ok: false, error: 'Endpoint no permitido' });
  }

  const apiKey = process.env.API_FOOTBALL_KEY || request.headers['x-betsify-key'];
  if (!apiKey) {
    return response.status(401).json({
      ok: false,
      error: 'Falta la API key. Añádela en Betsify o configura API_FOOTBALL_KEY en Vercel.'
    });
  }

  const query = new URLSearchParams();
  Object.entries(parameters).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
    else if (value !== undefined && value !== null && value !== '') query.set(key, value);
  });

  const url = `https://v3.football.api-sports.io/${endpoint}${query.size ? `?${query}` : ''}`;

  try {
    const upstream = await fetch(url, {
      headers: {
        'x-apisports-key': apiKey,
        Accept: 'application/json'
      }
    });
    const payload = await upstream.json();

    const daily = upstream.headers.get('x-ratelimit-requests-remaining');
    const minute = upstream.headers.get('x-ratelimit-remaining');
    if (daily !== null) response.setHeader('x-ratelimit-requests-remaining', daily);
    if (minute !== null) response.setHeader('x-ratelimit-remaining', minute);
    response.setHeader('Cache-Control', 'no-store');

    const errors = payload?.errors;
    const hasErrors = Array.isArray(errors)
      ? errors.length > 0
      : Boolean(errors && typeof errors === 'object' && Object.keys(errors).length);

    if (!upstream.ok || hasErrors) {
      return response.status(upstream.status >= 400 ? upstream.status : 400).json({
        ok: false,
        error: extractApiError(payload, upstream.status)
      });
    }

    return response.status(200).json({ ok: true, response: payload.response });
  } catch (error) {
    return response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo contactar con API-Football'
    });
  }
}
