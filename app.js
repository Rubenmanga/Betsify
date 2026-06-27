'use strict';

const $ = id => document.getElementById(id);
const CACHE_KEY = 'betsify_compact_cache_v3';
const OLD_CACHE_KEYS = ['betsify_free_cache_v1', 'betsify_free_cache_v2'];
const MAX_CACHED_MATCHES = 300;

for (const key of OLD_CACHE_KEYS) {
  try { localStorage.removeItem(key); } catch (_) {}
}

function loadCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    return { matches: parsed.matches && typeof parsed.matches === 'object' ? parsed.matches : {} };
  } catch (_) {
    return { matches: {} };
  }
}

const cache = loadCache();
const scheduleMemory = new Map();
const summaryMemory = new Map();
const state = { events: [], fixture: null, model: null };

function saveCache() {
  const entries = Object.entries(cache.matches)
    .sort((a, b) => (b[1].cachedAt || 0) - (a[1].cachedAt || 0))
    .slice(0, MAX_CACHED_MATCHES);

  cache.matches = Object.fromEntries(entries);

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    return true;
  } catch (_) {
    cache.matches = Object.fromEntries(entries.slice(0, 100));
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      return true;
    } catch (_) {
      try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
      return false;
    }
  }
}

const num = value => {
  const parsed = parseFloat(String(value ?? '').replace('%', ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const pct = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';

$('date').value = new Date().toISOString().slice(0, 10);

async function api(params) {
  const response = await fetch('/api/espn?' + new URLSearchParams(params));
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload.data;
}

function competitors(event) {
  const list = event.competitions?.[0]?.competitors || [];
  return {
    home: list.find(item => item.homeAway === 'home') || list[0],
    away: list.find(item => item.homeAway === 'away') || list[1]
  };
}

const teamName = competitor => competitor?.team?.displayName || competitor?.team?.name || 'Equipo';
const teamId = competitor => competitor?.team?.id || competitor?.id;
const score = competitor => num(competitor?.score?.value ?? competitor?.score);

$('load').onclick = async () => {
  try {
    $('fixtureStatus').textContent = 'Cargando partidos…';
    const data = await api({
      mode: 'scoreboard',
      league: 'fifa.world',
      date: $('date').value.replaceAll('-', '')
    });

    state.events = data.events || [];
    $('fixture').innerHTML = state.events.map((event, index) => {
      const teams = competitors(event);
      return `<option value="${index}">${teamName(teams.home)} — ${teamName(teams.away)}</option>`;
    }).join('') || '<option>Sin partidos</option>';

    state.fixture = state.events[0] || null;
    $('analyze').disabled = !state.fixture;
    $('fixtureStatus').textContent = state.fixture
      ? `${state.events.length} partidos encontrados.`
      : 'No hay partidos en esa fecha.';
  } catch (error) {
    $('fixtureStatus').textContent = 'Error: ' + error.message;
  }
};

$('fixture').onchange = () => {
  state.fixture = state.events[Number($('fixture').value)] || null;
  $('analyze').disabled = !state.fixture;
};

async function schedule(id) {
  const key = String(id);
  if (scheduleMemory.has(key)) return scheduleMemory.get(key);
  const data = await api({ mode: 'schedule', team: id, season: new Date().getUTCFullYear() });
  scheduleMemory.set(key, data);
  return data;
}

async function summary(event) {
  const key = String(event.id);
  if (summaryMemory.has(key)) return summaryMemory.get(key);
  const data = await api({ mode: 'summary', event: event.id, league: event.league?.slug || '' });
  summaryMemory.set(key, data);
  return data;
}

function statMap(box) {
  const result = {};
  for (const stat of box?.statistics || []) result[stat.name] = num(stat.value ?? stat.displayValue);
  return result;
}

function pick(map, names) {
  for (const name of names) if (map[name] != null) return map[name];
  return null;
}

function parseCompactMatch(event, data, id) {
  const list = event.competitions?.[0]?.competitors || [];
  const own = list.find(item => String(teamId(item)) === String(id));
  const opponent = list.find(item => item !== own);
  const boxes = data.boxscore?.teams || [];
  const ownBox = boxes.find(box => String(box.team?.id) === String(id));
  const opponentBox = boxes.find(box => String(box.team?.id) === String(teamId(opponent)));
  const stats = statMap(ownBox);
  const opponentStats = statMap(opponentBox);
  const leagueSlug = event.league?.slug || '';

  return {
    id: String(event.id),
    date: event.date?.slice(0, 10) || null,
    team: teamName(own),
    opponent: teamName(opponent),
    gf: score(own),
    ga: score(opponent),
    shots: pick(stats, ['totalShots', 'shots']),
    shotsAgainst: pick(opponentStats, ['totalShots', 'shots']),
    sot: pick(stats, ['shotsOnTarget']),
    sotAgainst: pick(opponentStats, ['shotsOnTarget']),
    corners: pick(stats, ['wonCorners', 'cornerKicks']),
    cornersAgainst: pick(opponentStats, ['wonCorners', 'cornerKicks']),
    yellow: pick(stats, ['yellowCards']),
    red: pick(stats, ['redCards']),
    possession: pick(stats, ['possessionPct']),
    friendly: leagueSlug.includes('friendly'),
    cachedAt: Date.now()
  };
}

async function teamData(id, label) {
  const data = await schedule(id);
  const events = (data.events || [])
    .filter(event => event.competitions?.[0]?.status?.type?.completed || event.status?.type?.completed)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 10);

  const rows = [];
  let addedToCache = false;

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const cacheKey = `${event.id}:${id}`;
    $('analysisStatus').textContent = `${label}: procesando ${index + 1}/${events.length}…`;

    let compact = cache.matches[cacheKey];
    if (!compact) {
      try {
        compact = parseCompactMatch(event, await summary(event), id);
      } catch (_) {
        compact = parseCompactMatch(event, {}, id);
      }
      cache.matches[cacheKey] = compact;
      addedToCache = true;
    }

    rows.push({ ...compact, weight: Math.pow(0.9, index) * (compact.friendly ? 0.55 : 1) });
  }

  if (addedToCache) saveCache();
  return rows;
}

function weighted(rows, field) {
  let sum = 0, weights = 0, count = 0;
  for (const row of rows) {
    if (row[field] != null) {
      sum += row[field] * row.weight;
      weights += row.weight;
      count++;
    }
  }
  return { value: weights ? sum / weights : null, count };
}

function aggregate(rows) {
  const result = { matches: rows.length };
  for (const field of ['gf', 'ga', 'shots', 'shotsAgainst', 'sot', 'sotAgainst', 'corners', 'cornersAgainst', 'yellow', 'red', 'possession']) {
    const item = weighted(rows, field);
    result[field] = item.value;
    result[field + 'Count'] = item.count;
  }
  return result;
}

function factorial(value) {
  let result = 1;
  for (let i = 2; i <= value; i++) result *= i;
  return result;
}

const poisson = (goals, lambda) => Math.exp(-lambda) * Math.pow(lambda, goals) / factorial(goals);

function createModel(home, away) {
  let homeGoals = ((home.gf ?? 1.2) + (away.ga ?? 1.2)) / 2;
  let awayGoals = ((away.gf ?? 1) + (home.ga ?? 1)) / 2;

  if (home.sotCount >= 5 && away.sotAgainstCount >= 5) {
    homeGoals *= Math.max(0.8, Math.min(1.2, ((home.sot + away.sotAgainst) / 2) / 4.2));
  }
  if (away.sotCount >= 5 && home.sotAgainstCount >= 5) {
    awayGoals *= Math.max(0.8, Math.min(1.2, ((away.sot + home.sotAgainst) / 2) / 4.2));
  }

  homeGoals = Math.max(0.2, Math.min(3.5, homeGoals));
  awayGoals = Math.max(0.2, Math.min(3.5, awayGoals));

  let homeWin = 0, draw = 0, awayWin = 0, over25 = 0, btts = 0;
  for (let homeScore = 0; homeScore <= 8; homeScore++) {
    for (let awayScore = 0; awayScore <= 8; awayScore++) {
      const probability = poisson(homeScore, homeGoals) * poisson(awayScore, awayGoals);
      if (homeScore > awayScore) homeWin += probability;
      else if (homeScore === awayScore) draw += probability;
      else awayWin += probability;
      if (homeScore + awayScore >= 3) over25 += probability;
      if (homeScore > 0 && awayScore > 0) btts += probability;
    }
  }
  return { homeGoals, awayGoals, homeWin, draw, awayWin, over25, btts };
}

const statCard = (label, value, digits = 2) => `<div class="stat"><span class="muted">${label}</span><b>${value == null ? '—' : Number(value).toFixed(digits)}</b></div>`;

function renderTeam(id, data) {
  $(id).innerHTML =
    statCard('Goles a favor', data.gf) + statCard('Goles en contra', data.ga) +
    statCard('Tiros', data.shots) + statCard('A puerta', data.sot) +
    statCard('Córners', data.corners) + statCard('Amarillas', data.yellow) +
    statCard('Posesión %', data.possession) + statCard('Partidos', data.matches, 0);
}

$('analyze').onclick = async () => {
  if (!state.fixture) return;
  try {
    const teams = competitors(state.fixture);
    const homeLabel = teamName(teams.home), awayLabel = teamName(teams.away);
    $('analysisStatus').textContent = 'Buscando historiales…';

    const [homeRows, awayRows] = await Promise.all([
      teamData(teamId(teams.home), homeLabel),
      teamData(teamId(teams.away), awayLabel)
    ]);

    const homeAggregate = aggregate(homeRows), awayAggregate = aggregate(awayRows);
    state.model = createModel(homeAggregate, awayAggregate);

    $('homeName').textContent = homeLabel;
    $('awayName').textContent = awayLabel;
    renderTeam('homeStats', homeAggregate);
    renderTeam('awayStats', awayAggregate);
    $('homeCoverage').textContent = `Cobertura: ${homeAggregate.shotsCount}/${homeAggregate.matches} con tiros; ${homeAggregate.cornersCount}/${homeAggregate.matches} con córners.`;
    $('awayCoverage').textContent = `Cobertura: ${awayAggregate.shotsCount}/${awayAggregate.matches} con tiros; ${awayAggregate.cornersCount}/${awayAggregate.matches} con córners.`;
    $('matches').innerHTML = [...homeRows, ...awayRows].map(row => `<tr><td>${row.date || '—'}</td><td>${row.team}</td><td>${row.opponent}</td><td>${row.gf ?? '—'}-${row.ga ?? '—'}</td><td>${row.shots ?? '—'}</td><td>${row.sot ?? '—'}</td><td>${row.corners ?? '—'}</td><td>${row.yellow ?? '—'}</td></tr>`).join('');
    $('labelHome').textContent = 'Victoria ' + homeLabel;
    $('labelAway').textContent = 'Victoria ' + awayLabel;
    $('teamResults').classList.remove('hidden');
    $('oddsCard').classList.remove('hidden');
    $('analysisStatus').textContent = `Listo: ${homeRows.length} partidos de ${homeLabel} y ${awayRows.length} de ${awayLabel}.`;
  } catch (error) {
    $('analysisStatus').textContent = 'No se pudo completar: ' + error.message;
  }
};

$('compare').onclick = () => {
  const model = state.model;
  if (!model) return;
  const rows = [
    ['Victoria local', model.homeWin, num($('oddHome').value)],
    ['Empate', model.draw, num($('oddDraw').value)],
    ['Victoria visitante', model.awayWin, num($('oddAway').value)],
    ['Over 2.5', model.over25, num($('oddOver').value)],
    ['Ambos marcan — Sí', model.btts, num($('oddBtts').value)]
  ];

  $('modelStats').innerHTML =
    statCard('Goles esperados local', model.homeGoals) +
    statCard('Goles esperados visitante', model.awayGoals) +
    statCard('Total esperado', model.homeGoals + model.awayGoals) +
    statCard('BTTS %', model.btts * 100, 1);

  $('markets').innerHTML = rows.map(([name, probability, odd]) => {
    const fairOdd = 1 / probability;
    const ev = odd ? probability * odd - 1 : null;
    return `<tr><td>${name}</td><td>${pct(probability)}</td><td>${fairOdd.toFixed(2)}</td><td>${odd?.toFixed(2) || '—'}</td><td class="${ev > 0 ? 'good' : ev < 0 ? 'bad' : ''}">${ev == null ? '—' : pct(ev)}</td></tr>`;
  }).join('');
  $('modelCard').classList.remove('hidden');
};

$('clear').onclick = () => {
  for (const key of [CACHE_KEY, ...OLD_CACHE_KEYS]) {
    try { localStorage.removeItem(key); } catch (_) {}
  }
  location.reload();
};

$('load').click();
