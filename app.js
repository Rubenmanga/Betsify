'use strict';

const $ = (id) => document.getElementById(id);
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
const numberOrNull = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const percent = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
const money = (value) => `${value < 0 ? '-' : ''}€${Math.abs(value || 0).toFixed(2)}`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2500);
}

function localDate(daysOffset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

const Cache = {
  prefix: 'betsify_api_',
  get(key) {
    try {
      const entry = JSON.parse(localStorage.getItem(this.prefix + key));
      if (!entry || Date.now() > entry.expires) {
        localStorage.removeItem(this.prefix + key);
        return null;
      }
      return entry.data;
    } catch {
      return null;
    }
  },
  set(key, data, ttl) {
    try {
      localStorage.setItem(this.prefix + key, JSON.stringify({ data, expires: Date.now() + ttl }));
    } catch {}
    this.render();
  },
  clear() {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(this.prefix))
      .forEach((key) => localStorage.removeItem(key));
    this.render();
  },
  render() {
    $('cache-count').textContent = Object.keys(localStorage)
      .filter((key) => key.startsWith(this.prefix)).length;
  }
};

const API = {
  base: '/api/football',
  getKey() {
    return localStorage.getItem('betsify_api_key') || '';
  },
  setKey(key) {
    localStorage.setItem('betsify_api_key', key.trim());
  },
  async request(endpoint, params = {}, ttl = 0) {
    const key = this.getKey();
    if (!key) throw new Error('Falta la API key');

    const query = new URLSearchParams({ endpoint });
    Object.entries(params).forEach(([name, value]) => {
      if (value !== '' && value !== null && value !== undefined) query.set(name, String(value));
    });

    const cacheKey = query.toString();
    if (ttl) {
      const cached = Cache.get(cacheKey);
      if (cached) return cached;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(`${this.base}?${query}`, {
        headers: { 'x-betsify-key': key, Accept: 'application/json' },
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('La API tardó demasiado en responder');
      throw new Error('No se pudo conectar con el proxy de Vercel');
    } finally {
      clearTimeout(timer);
    }

    const daily = response.headers.get('x-ratelimit-requests-remaining');
    const minute = response.headers.get('x-ratelimit-remaining');
    if (daily !== null) $('quota-daily').textContent = daily;
    if (minute !== null) $('quota-minute').textContent = minute;

    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error('El servidor devolvió una respuesta no válida');
    }

    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `HTTP ${response.status}`);
    }

    const data = body.response ?? [];
    if (ttl) Cache.set(cacheKey, data, ttl);
    return data;
  },
  status() {
    return this.request('status');
  },
  fixtures(date, league = 1) {
    return this.request('fixtures', {
      date,
      league,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }, 15 * 60 * 1000);
  },
  teamStats(league, season, team) {
    return this.request('teams/statistics', { league, season, team }, 12 * 60 * 60 * 1000);
  },
  prediction(fixture) {
    return this.request('predictions', { fixture }, 60 * 60 * 1000);
  },
  odds(fixture) {
    return this.request('odds', { fixture }, 2 * 60 * 60 * 1000);
  }
};

const State = {
  fixtures: [],
  fixture: null,
  model: null,
  apiPrediction: null,
  odds: [],
  plan: null,
  statsSeason: null,
  bankroll: numberOrNull(localStorage.getItem('betsify_bankroll'))
    ?? numberOrNull(localStorage.getItem('edge2026_bankroll'))
    ?? 0,
  bets: JSON.parse(localStorage.getItem('betsify_bets') || localStorage.getItem('edge2026_bets') || '[]')
};

function saveBets() {
  localStorage.setItem('betsify_bets', JSON.stringify(State.bets));
}
function saveBankroll() {
  localStorage.setItem('betsify_bankroll', String(State.bankroll));
}

function isFreePlan() {
  return String(State.plan || '').toLowerCase().includes('free');
}

async function detectPlan() {
  if (State.plan) return State.plan;
  try {
    const status = await API.status();
    State.plan = status?.subscription?.plan || 'Unknown';
  } catch {
    State.plan = 'Unknown';
  }
  return State.plan;
}

function poisson(lambda, goals) {
  if (lambda <= 0) return goals === 0 ? 1 : 0;
  let logProbability = -lambda + goals * Math.log(lambda);
  for (let i = 1; i <= goals; i += 1) logProbability -= Math.log(i);
  return Math.exp(logProbability);
}

function scoreGrid(homeLambda, awayLambda) {
  const cells = [];
  let total = 0;
  for (let home = 0; home <= 9; home += 1) {
    for (let away = 0; away <= 9; away += 1) {
      const probability = poisson(homeLambda, home) * poisson(awayLambda, away);
      cells.push({ home, away, probability });
      total += probability;
    }
  }
  return cells.map((cell) => ({ ...cell, probability: cell.probability / total }));
}

function deriveMarkets(grid) {
  let home = 0, draw = 0, away = 0, over = 0, btts = 0;
  grid.forEach((cell) => {
    if (cell.home > cell.away) home += cell.probability;
    else if (cell.home === cell.away) draw += cell.probability;
    else away += cell.probability;
    if (cell.home + cell.away > 2.5) over += cell.probability;
    if (cell.home > 0 && cell.away > 0) btts += cell.probability;
  });
  return { home, draw, away, over, under: 1 - over, btts, noBtts: 1 - btts };
}

function normalize1X2(values) {
  const total = values.home + values.draw + values.away;
  return total
    ? { home: values.home / total, draw: values.draw / total, away: values.away / total }
    : { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
}

function parsePredictionPercent(prediction) {
  const values = prediction?.predictions?.percent;
  if (!values) return null;
  const home = numberOrNull(String(values.home ?? '').replace('%', ''));
  const draw = numberOrNull(String(values.draw ?? '').replace('%', ''));
  const away = numberOrNull(String(values.away ?? '').replace('%', ''));
  if (home === null || draw === null || away === null) return null;
  return normalize1X2({ home: home / 100, draw: draw / 100, away: away / 100 });
}

function safeAverage(value, fallback = 1.25) {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

function buildTeamSummary(fixture, stats, homeTeam, source) {
  const side = homeTeam ? 'home' : 'away';
  const team = fixture.teams[side];
  return {
    name: team.name,
    logo: team.logo,
    id: team.id,
    played: stats?.fixtures?.played?.total || 0,
    goalsFor: safeAverage(stats?.goals?.for?.average?.total),
    goalsAgainst: safeAverage(stats?.goals?.against?.average?.total),
    wins: stats?.fixtures?.wins?.total || 0,
    draws: stats?.fixtures?.draws?.total || 0,
    losses: stats?.fixtures?.loses?.total || 0,
    form: stats?.form || '—',
    source
  };
}

function buildModel(homeTeam, awayTeam, prediction) {
  const competitionMean = 1.25;
  let homeLambda = (homeTeam.goalsFor * 0.58 + awayTeam.goalsAgainst * 0.42) * 1.08;
  let awayLambda = (awayTeam.goalsFor * 0.58 + homeTeam.goalsAgainst * 0.42) * 0.96;

  homeLambda = homeLambda * 0.82 + competitionMean * 0.18;
  awayLambda = awayLambda * 0.82 + competitionMean * 0.18;

  const predictedGoals = prediction?.predictions?.goals;
  const apiHomeGoals = numberOrNull(predictedGoals?.home);
  const apiAwayGoals = numberOrNull(predictedGoals?.away);
  if (apiHomeGoals !== null) homeLambda = homeLambda * 0.78 + apiHomeGoals * 0.22;
  if (apiAwayGoals !== null) awayLambda = awayLambda * 0.78 + apiAwayGoals * 0.22;

  homeLambda = clamp(homeLambda, 0.15, 4.5);
  awayLambda = clamp(awayLambda, 0.15, 4.5);

  const markets = deriveMarkets(scoreGrid(homeLambda, awayLambda));
  const poissonProbability = normalize1X2(markets);
  const apiProbability = parsePredictionPercent(prediction);
  const finalProbability = apiProbability
    ? normalize1X2({
        home: poissonProbability.home * 0.75 + apiProbability.home * 0.25,
        draw: poissonProbability.draw * 0.75 + apiProbability.draw * 0.25,
        away: poissonProbability.away * 0.75 + apiProbability.away * 0.25
      })
    : poissonProbability;

  return {
    homeLambda,
    awayLambda,
    poissonProbability,
    apiProbability,
    finalProbability,
    markets
  };
}

function setApiMessage(message, type = '') {
  const element = $('api-message');
  element.textContent = message;
  element.className = `status ${type}`;
}

function renderFixtureOptions() {
  const select = $('fixture-select');
  select.innerHTML = '<option value="">— Elige un partido —</option>' + State.fixtures.map((fixture, index) => {
    const time = new Date(fixture.fixture.date).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    return `<option value="${index}">${time} · ${escapeHtml(fixture.teams.home.name)} vs ${escapeHtml(fixture.teams.away.name)} · ${escapeHtml(fixture.league.name)}</option>`;
  }).join('');
  select.disabled = State.fixtures.length === 0;
  $('analyze-fixture').disabled = true;
}

async function loadFixtures() {
  const date = $('fixture-date').value;
  const league = numberOrNull($('league-id').value) || 1;
  if (!API.getKey()) {
    setApiMessage('Añade primero tu API key en la pestaña API.', 'err');
    return;
  }

  const button = $('load-fixtures');
  button.disabled = true;
  button.textContent = 'Cargando…';

  try {
    await detectPlan();
    if (isFreePlan() && (date < localDate(-1) || date > localDate(1))) {
      throw new Error('El plan gratuito solo permite consultar ayer, hoy o mañana');
    }

    State.fixtures = await API.fixtures(date, league);
    renderFixtureOptions();
    if (State.fixtures.length) {
      setApiMessage(`${State.fixtures.length} partidos cargados. Mundial: league=1, season=2026. Plan ${State.plan}.`, 'ok');
    } else {
      setApiMessage('No hay fixtures conocidos para esa fecha. Los cruces eliminatorios se añaden cuando ambos equipos están confirmados.');
    }
  } catch (error) {
    setApiMessage(`Error al cargar fixtures: ${error.message}`, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Cargar partidos';
  }
}

async function loadTeamStats(fixture, teamId) {
  const preferredSeason = isFreePlan() ? 2022 : fixture.league.season;
  try {
    const stats = await API.teamStats(fixture.league.id, preferredSeason, teamId);
    if (stats && Object.keys(stats).length) {
      return { stats, source: `World Cup ${preferredSeason}` };
    }
  } catch {}

  if (preferredSeason !== 2022) {
    try {
      const stats = await API.teamStats(fixture.league.id, 2022, teamId);
      if (stats && Object.keys(stats).length) return { stats, source: 'World Cup 2022 (fallback)' };
    } catch {}
  }

  return { stats: null, source: 'Base neutral: datos no disponibles' };
}

async function analyzeFixture() {
  const index = numberOrNull($('fixture-select').value);
  if (index === null || !State.fixtures[index]) return;

  State.fixture = State.fixtures[index];
  const fixture = State.fixture;
  const button = $('analyze-fixture');
  button.disabled = true;
  button.textContent = 'Analizando…';
  setApiMessage('Consultando datos disponibles sin bloquear el análisis…');

  try {
    await detectPlan();
    const results = await Promise.allSettled([
      loadTeamStats(fixture, fixture.teams.home.id),
      loadTeamStats(fixture, fixture.teams.away.id),
      API.prediction(fixture.fixture.id),
      API.odds(fixture.fixture.id)
    ]);

    const homeResult = results[0].status === 'fulfilled' ? results[0].value : { stats: null, source: 'Base neutral' };
    const awayResult = results[1].status === 'fulfilled' ? results[1].value : { stats: null, source: 'Base neutral' };
    const predictions = results[2].status === 'fulfilled' ? results[2].value : [];
    const odds = results[3].status === 'fulfilled' ? results[3].value : [];

    State.apiPrediction = Array.isArray(predictions) ? predictions[0] || null : null;
    State.odds = Array.isArray(odds) ? odds : [];

    const homeTeam = buildTeamSummary(fixture, homeResult.stats, true, homeResult.source);
    const awayTeam = buildTeamSummary(fixture, awayResult.stats, false, awayResult.source);
    State.model = buildModel(homeTeam, awayTeam, State.apiPrediction);

    renderAnalysis(fixture, homeTeam, awayTeam);

    const missing = [];
    if (!State.apiPrediction) missing.push('predicción API');
    if (!State.odds.length) missing.push('cuotas');
    const suffix = missing.length ? ` No disponibles todavía: ${missing.join(' y ')}.` : '';
    setApiMessage(`Análisis generado con los datos disponibles.${suffix}`, 'ok');
  } catch (error) {
    setApiMessage(`No se pudo generar el análisis: ${error.message}`, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Analizar fixture';
  }
}

function renderTeamCard(team) {
  return `<div class="card">
    <div class="fixture-team"><img src="${escapeHtml(team.logo)}" alt=""><span>${escapeHtml(team.name)}</span></div>
    <div class="stat-grid" style="margin-top:12px">
      <div class="stat"><strong>${team.goalsFor.toFixed(2)}</strong><small>GF/partido</small></div>
      <div class="stat"><strong>${team.goalsAgainst.toFixed(2)}</strong><small>GC/partido</small></div>
      <div class="stat"><strong>${team.played}</strong><small>Jugados</small></div>
      <div class="stat"><strong class="green">${team.wins}</strong><small>Victorias</small></div>
      <div class="stat"><strong class="yellow">${team.draws}</strong><small>Empates</small></div>
      <div class="stat"><strong class="red">${team.losses}</strong><small>Derrotas</small></div>
    </div>
    <div class="note" style="margin-top:9px">Forma: ${escapeHtml(team.form)} · Fuente: ${escapeHtml(team.source)}</div>
  </div>`;
}

function renderComparison(model) {
  const row = (label, values) => `<div>${label}</div><div class="green">${values ? percent(values.home) : '—'}</div><div class="yellow">${values ? percent(values.draw) : '—'}</div><div class="blue">${values ? percent(values.away) : '—'}</div>`;
  $('model-comparison').innerHTML = '<div class="head">Modelo</div><div class="head">1</div><div class="head">X</div><div class="head">2</div>'
    + row('Poisson Betsify', model.poissonProbability)
    + row('API-Football', model.apiProbability)
    + row('Ensemble final', model.finalProbability);
}

function renderMarkets() {
  const model = State.model;
  const definitions = [
    ['1X2', 'odd-home', 'Local', model.finalProbability.home, 'odd-draw', 'Empate', model.finalProbability.draw, 'odd-away', 'Visitante', model.finalProbability.away],
    ['Goles 2.5', 'odd-over', 'Over 2.5', model.markets.over, 'odd-under', 'Under 2.5', model.markets.under],
    ['Ambos marcan', 'odd-btts-yes', 'Sí', model.markets.btts, 'odd-btts-no', 'No', model.markets.noBtts]
  ];

  $('markets').innerHTML = definitions.map((definition) => {
    const count = (definition.length - 1) / 3;
    const inputs = Array.from({ length: count }, (_, index) => {
      const position = 1 + index * 3;
      return `<div><label>${definition[position + 1]} · ${percent(definition[position + 2])}</label><input type="number" min="1.01" step=".01" id="${definition[position]}" placeholder="Cuota"></div>`;
    }).join('');
    return `<div class="market"><div class="market-head"><strong>${definition[0]}</strong></div><div class="market-inputs">${inputs}</div></div>`;
  }).join('');

  fillOdds(State.odds);
}

function bestOdds(rawOdds) {
  const result = {};
  for (const event of rawOdds || []) {
    for (const bookmaker of event.bookmakers || []) {
      for (const bet of bookmaker.bets || []) {
        const betName = String(bet.name || '').toLowerCase();
        for (const valueEntry of bet.values || []) {
          const valueName = String(valueEntry.value || '').toLowerCase();
          const odd = numberOrNull(valueEntry.odd);
          if (!odd) continue;
          let key = null;
          if (betName.includes('match winner')) {
            key = valueName === 'home' ? 'home' : valueName === 'draw' ? 'draw' : valueName === 'away' ? 'away' : null;
          } else if (betName.includes('over/under')) {
            key = valueName === 'over 2.5' ? 'over' : valueName === 'under 2.5' ? 'under' : null;
          } else if (betName.includes('both team')) {
            key = valueName === 'yes' ? 'bttsYes' : valueName === 'no' ? 'bttsNo' : null;
          }
          if (key && (!result[key] || odd > result[key].odd)) result[key] = { odd, bookmaker: bookmaker.name };
        }
      }
    }
  }
  return result;
}

function fillOdds(rawOdds) {
  const odds = bestOdds(rawOdds);
  const mapping = {
    home: 'odd-home', draw: 'odd-draw', away: 'odd-away',
    over: 'odd-over', under: 'odd-under',
    bttsYes: 'odd-btts-yes', bttsNo: 'odd-btts-no'
  };
  Object.entries(mapping).forEach(([key, id]) => {
    if (odds[key] && $(id)) $(id).value = odds[key].odd;
  });
  const bookmakers = [...new Set(Object.values(odds).map((item) => item.bookmaker))];
  $('odds-source').textContent = bookmakers.length
    ? `Mejores cuotas encontradas entre: ${bookmakers.join(', ')}`
    : 'No hay cuotas disponibles todavía. API-Sports suele publicarlas entre 1 y 14 días antes; puedes introducirlas manualmente.';
}

function renderAnalysis(fixture, homeTeam, awayTeam) {
  $('analysis-output').classList.remove('hidden');
  const dateTime = new Date(fixture.fixture.date).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
  $('fixture-card').innerHTML = `<div class="section-label">${escapeHtml(fixture.league.name)} · ${escapeHtml(fixture.league.round || '')}</div>
    <div class="grid grid-2">
      <div class="fixture-team"><img src="${escapeHtml(fixture.teams.home.logo)}"><span>${escapeHtml(fixture.teams.home.name)}</span></div>
      <div class="fixture-team" style="justify-content:flex-end"><span>${escapeHtml(fixture.teams.away.name)}</span><img src="${escapeHtml(fixture.teams.away.logo)}"></div>
    </div>
    <div class="fixture-meta"><span>${dateTime}</span><span>${escapeHtml(fixture.fixture.venue?.name || 'Sede por confirmar')}</span><span>Fixture #${fixture.fixture.id}</span></div>`;

  $('team-cards').innerHTML = renderTeamCard(homeTeam) + renderTeamCard(awayTeam);
  const probabilities = State.model.finalProbability;
  $('prob-home-name').textContent = homeTeam.name;
  $('prob-away-name').textContent = awayTeam.name;
  $('prob-home').textContent = percent(probabilities.home);
  $('prob-draw').textContent = percent(probabilities.draw);
  $('prob-away').textContent = percent(probabilities.away);
  $('bar-home').style.width = `${probabilities.home * 100}%`;
  $('bar-draw').style.width = `${probabilities.draw * 100}%`;
  $('bar-away').style.width = `${probabilities.away * 100}%`;
  $('lambda-line').textContent = `Goles esperados del modelo: ${homeTeam.name} ${State.model.homeLambda.toFixed(2)} — ${awayTeam.name} ${State.model.awayLambda.toFixed(2)}. No son xG oficiales.`;
  renderComparison(State.model);
  $('api-advice').textContent = State.apiPrediction?.predictions?.advice
    ? `API-Football: ${State.apiPrediction.predictions.advice}`
    : 'API-Football no ofrece una predicción fiable para este fixture; Betsify usa el modelo propio y los datos de respaldo.';
  renderMarkets();
  $('ev-card').classList.add('hidden');
  $('bet-match').value = `${homeTeam.name} vs ${awayTeam.name}`;
  $('analysis-output').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function calculateEV() {
  if (!State.model) return;
  const getOdd = (id) => numberOrNull($(id)?.value);
  const candidates = [
    ['1 · Local', State.model.finalProbability.home, getOdd('odd-home')],
    ['X · Empate', State.model.finalProbability.draw, getOdd('odd-draw')],
    ['2 · Visitante', State.model.finalProbability.away, getOdd('odd-away')],
    ['Over 2.5', State.model.markets.over, getOdd('odd-over')],
    ['Under 2.5', State.model.markets.under, getOdd('odd-under')],
    ['BTTS Sí', State.model.markets.btts, getOdd('odd-btts-yes')],
    ['BTTS No', State.model.markets.noBtts, getOdd('odd-btts-no')]
  ];

  const markets = candidates
    .filter((item) => item[2] && item[2] >= 1.01)
    .map(([name, probability, odds]) => ({
      name, probability, odds,
      ev: probability * odds - 1,
      fairOdds: 1 / probability
    }))
    .sort((a, b) => b.ev - a.ev);

  if (!markets.length) {
    toast('Introduce al menos una cuota');
    return;
  }

  $('ev-list').innerHTML = markets.map((market) => `<div class="ev-row"><div><div class="ev-name">${escapeHtml(market.name)}</div><div class="ev-sub">Prob. ${percent(market.probability)} · justa ${market.fairOdds.toFixed(2)} · mercado ${market.odds.toFixed(2)}</div></div><span class="chip ${market.ev >= 0.05 ? 'pos' : market.ev >= 0 ? 'mid' : 'neg'}">${market.ev >= 0 ? '+' : ''}${(market.ev * 100).toFixed(1)}% EV</span></div>`).join('');
  $('ev-card').classList.remove('hidden');
}

function settledStats() {
  const settled = State.bets.filter((bet) => ['win', 'loss', 'void'].includes(bet.result));
  let invested = 0, returns = 0;
  settled.forEach((bet) => {
    if (bet.result === 'void') return;
    invested += bet.stake;
    if (bet.result === 'win') returns += bet.stake * bet.odds;
  });
  return { invested, profit: returns - invested, roi: invested ? (returns - invested) / invested : 0 };
}

function renderBankroll() {
  const stats = settledStats();
  $('bankroll-value').textContent = money(State.bankroll);
  $('bankroll-input').value = State.bankroll || '';
  $('sum-invested').textContent = money(stats.invested);
  $('sum-profit').textContent = money(stats.profit);
  $('sum-profit').className = stats.profit >= 0 ? 'green' : 'red';
  $('sum-roi').textContent = `${stats.roi >= 0 ? '+' : ''}${(stats.roi * 100).toFixed(1)}%`;
  $('sum-roi').className = stats.roi >= 0 ? 'green' : 'red';
}

function renderBets() {
  const container = $('bets-list');
  if (!State.bets.length) {
    container.innerHTML = '<div class="card note">Todavía no hay apuestas registradas.</div>';
    renderBankroll();
    return;
  }
  container.innerHTML = State.bets.map((bet) => `<div class="bet"><div class="bet-top"><div><div class="bet-title">${escapeHtml(bet.match)}</div><div class="bet-sub">${escapeHtml(bet.market)} · ${escapeHtml(bet.date || '')}</div></div><div style="text-align:right"><strong>${Number(bet.odds).toFixed(2)}</strong><div class="bet-sub">${money(bet.stake)}</div></div></div><div class="bet-actions">${bet.result === 'pending' ? `<button class="btn btn-sm btn-primary" onclick="setBetResult(${bet.id},'win')">WIN</button><button class="btn btn-sm btn-danger" onclick="setBetResult(${bet.id},'loss')">LOSS</button><button class="btn btn-sm btn-secondary" onclick="setBetResult(${bet.id},'void')">VOID</button>` : `<span class="chip ${bet.result === 'win' ? 'pos' : bet.result === 'loss' ? 'neg' : 'mid'}">${bet.result.toUpperCase()}</span>`}<button class="btn btn-sm btn-secondary" onclick="deleteBet(${bet.id})" style="margin-left:auto">Eliminar</button></div></div>`).join('');
  renderBankroll();
}

window.setBetResult = (id, result) => {
  const bet = State.bets.find((item) => item.id === id);
  if (bet) {
    bet.result = result;
    saveBets();
    renderBets();
  }
};
window.deleteBet = (id) => {
  State.bets = State.bets.filter((item) => item.id !== id);
  saveBets();
  renderBets();
};

function addBet() {
  const match = $('bet-match').value.trim();
  const market = $('bet-market').value.trim();
  const odds = numberOrNull($('bet-odds').value);
  const stake = numberOrNull($('bet-stake').value);
  if (!match || !market || !odds || odds < 1.01 || !stake || stake <= 0) {
    toast('Completa todos los campos');
    return;
  }
  State.bets.unshift({ id: Date.now(), match, market, odds, stake, result: 'pending', date: new Date().toLocaleDateString('es-ES') });
  saveBets();
  renderBets();
  ['bet-market', 'bet-odds', 'bet-stake'].forEach((id) => { $(id).value = ''; });
  toast('Apuesta añadida');
}

function calculateKelly() {
  const rawProbability = numberOrNull($('kelly-prob').value);
  const odds = numberOrNull($('kelly-odds').value);
  if (!rawProbability || rawProbability <= 0 || rawProbability >= 100 || !odds || odds < 1.01) {
    toast('Datos inválidos');
    return;
  }
  const probability = rawProbability / 100;
  const b = odds - 1;
  const rawKelly = (b * probability - (1 - probability)) / b;
  const fraction = Math.min(0.05, Math.max(0, rawKelly / 2));
  const ev = probability * odds - 1;
  $('kelly-result').innerHTML = ev <= 0
    ? `<span class="red">EV ${(ev * 100).toFixed(1)}%: no apostar.</span>`
    : `Stake sugerido: <strong class="green">${money(fraction * State.bankroll)}</strong> (${(fraction * 100).toFixed(1)}% del bankroll) · EV +${(ev * 100).toFixed(1)}%`;
}

function updateKeyStatus(message, type = '') {
  const element = $('key-status');
  element.className = `status ${type}`;
  element.textContent = message;
}

function init() {
  const oldKey = localStorage.getItem('wc26_apikey');
  if (oldKey && !API.getKey()) API.setKey(oldKey);

  $('fixture-date').value = localDate();
  $('fixture-date').min = localDate(-1);
  $('fixture-date').max = localDate(1);
  $('league-id').value = '1';
  $('api-key').value = API.getKey();
  updateKeyStatus(API.getKey() ? 'Clave guardada en este navegador.' : 'Sin API key.');
  Cache.render();
  renderBankroll();
  renderBets();

  document.querySelectorAll('.tab-btn').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${button.dataset.tab}`));
  }));

  $('load-fixtures').addEventListener('click', loadFixtures);
  $('fixture-select').addEventListener('change', () => { $('analyze-fixture').disabled = !$('fixture-select').value; });
  $('analyze-fixture').addEventListener('click', analyzeFixture);
  $('calculate-ev').addEventListener('click', calculateEV);
  $('save-key').addEventListener('click', () => {
    API.setKey($('api-key').value);
    State.plan = null;
    Cache.clear();
    updateKeyStatus(API.getKey() ? 'Clave guardada.' : 'Clave eliminada.', API.getKey() ? 'ok' : '');
    toast('Configuración guardada');
  });
  $('test-key').addEventListener('click', async () => {
    updateKeyStatus('Probando conexión…');
    try {
      State.plan = null;
      const plan = await detectPlan();
      updateKeyStatus(`Conexión correcta. Plan: ${plan}.`, 'ok');
    } catch (error) {
      updateKeyStatus(`Error: ${error.message}`, 'err');
    }
  });
  $('clear-cache').addEventListener('click', () => { Cache.clear(); toast('Caché limpiada'); });
  $('save-bankroll').addEventListener('click', () => {
    const value = numberOrNull($('bankroll-input').value);
    if (value === null || value < 0) return toast('Bankroll inválido');
    State.bankroll = value;
    saveBankroll();
    renderBankroll();
    toast('Bankroll guardado');
  });
  $('calc-kelly').addEventListener('click', calculateKelly);
  $('add-bet').addEventListener('click', addBet);
}

init();
