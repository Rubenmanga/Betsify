'use strict';

const EDITABLE_FIELDS = [
  'gf','ga','shots','shotsAgainst','sot','sotAgainst','corners','cornersAgainst','yellow'
];

const MIRROR_FIELDS = {
  gf: 'ga',
  ga: 'gf',
  shots: 'shotsAgainst',
  shotsAgainst: 'shots',
  sot: 'sotAgainst',
  sotAgainst: 'sot',
  corners: 'cornersAgainst',
  cornersAgainst: 'corners'
};

function findCachedMatch(date, team, opponent) {
  return Object.entries(cache.matches).find(([, match]) =>
    match.date === date && match.team === team && match.opponent === opponent
  ) || null;
}

function findCounterpart(match) {
  return Object.entries(cache.matches).find(([, candidate]) =>
    candidate.id === match.id &&
    candidate.team === match.opponent &&
    candidate.opponent === match.team
  ) || null;
}

function editableNumber(value, field, cacheKey) {
  const shown = value == null ? '' : value;
  return `<input class="match-data-input" type="number" min="0" step="1" inputmode="numeric" placeholder="—" value="${shown}" data-field="${field}" data-cache-key="${cacheKey}">`;
}

function ensureEditorStyles() {
  if (document.getElementById('data-editor-styles')) return;
  const style = document.createElement('style');
  style.id = 'data-editor-styles';
  style.textContent = `
    .data-editor-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}
    .data-editor-toolbar button{width:auto;min-width:170px}
    .match-data-input{width:70px;min-width:62px;padding:8px;text-align:center;border-radius:9px}
    .score-editor{display:flex;align-items:center;gap:5px;white-space:nowrap}
    .score-editor .match-data-input{width:54px;min-width:50px}
    .manual-source{white-space:nowrap;font-size:12px;color:var(--muted)}
    .manual-source.edited{color:var(--accent);font-weight:800}
    .data-edit-note{font-size:12px;color:var(--muted)}
    @media(max-width:760px){.match-data-input{width:62px}.data-editor-toolbar button{width:100%}}
  `;
  document.head.appendChild(style);
}

function ensureEditorToolbar() {
  if (document.getElementById('saveManualData')) return;
  const table = document.getElementById('matches')?.closest('table');
  const scroll = table?.parentElement;
  if (!scroll) return;

  const toolbar = document.createElement('div');
  toolbar.className = 'data-editor-toolbar';
  toolbar.innerHTML = `
    <button id="saveManualData" type="button">Guardar y recalcular</button>
    <button id="resetManualData" type="button" class="secondary">Restablecer manuales</button>
    <span id="manualDataStatus" class="data-edit-note">Completa los valores vacíos o corrige cualquier cifra. También puedes añadir las estadísticas recibidas.</span>
  `;
  scroll.parentElement.insertBefore(toolbar, scroll);
  document.getElementById('saveManualData').addEventListener('click', saveManualData);
  document.getElementById('resetManualData').addEventListener('click', resetManualData);
}

function ensureExtraHeaders(table) {
  const headerRow = table.querySelector('thead tr');
  if (!headerRow || headerRow.querySelector('[data-editor-header]')) return;

  const headers = ['Tiros riv.', 'A puerta riv.', 'Córners riv.', 'Origen'];
  headers.forEach((label, index) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (index === headers.length - 1) th.dataset.editorHeader = 'true';
    headerRow.appendChild(th);
  });
}

function enhanceDataTable() {
  ensureEditorStyles();
  ensureEditorToolbar();

  const tbody = document.getElementById('matches');
  const table = tbody?.closest('table');
  if (!tbody || !table || !tbody.children.length) return;

  ensureExtraHeaders(table);

  [...tbody.rows].forEach(row => {
    if (row.dataset.editable === 'true') return;
    const cells = row.cells;
    if (cells.length < 8) return;

    const date = cells[0].textContent.trim();
    const team = cells[1].textContent.trim();
    const opponent = cells[2].textContent.trim();
    const matchEntry = findCachedMatch(date, team, opponent);
    if (!matchEntry) return;

    const [cacheKey, match] = matchEntry;
    row.dataset.cacheKey = cacheKey;

    cells[3].innerHTML = `<span class="score-editor">${editableNumber(match.gf, 'gf', cacheKey)}<span>–</span>${editableNumber(match.ga, 'ga', cacheKey)}</span>`;
    cells[4].innerHTML = editableNumber(match.shots, 'shots', cacheKey);
    cells[5].innerHTML = editableNumber(match.sot, 'sot', cacheKey);
    cells[6].innerHTML = editableNumber(match.corners, 'corners', cacheKey);
    cells[7].innerHTML = editableNumber(match.yellow, 'yellow', cacheKey);

    const shotsAgainstCell = document.createElement('td');
    shotsAgainstCell.innerHTML = editableNumber(match.shotsAgainst, 'shotsAgainst', cacheKey);
    row.appendChild(shotsAgainstCell);

    const sotAgainstCell = document.createElement('td');
    sotAgainstCell.innerHTML = editableNumber(match.sotAgainst, 'sotAgainst', cacheKey);
    row.appendChild(sotAgainstCell);

    const cornersAgainstCell = document.createElement('td');
    cornersAgainstCell.innerHTML = editableNumber(match.cornersAgainst, 'cornersAgainst', cacheKey);
    row.appendChild(cornersAgainstCell);

    const sourceCell = document.createElement('td');
    sourceCell.className = match.manualFields && Object.keys(match.manualFields).length
      ? 'manual-source edited'
      : 'manual-source';
    sourceCell.textContent = sourceCell.classList.contains('edited') ? 'Manual' : 'API';
    row.appendChild(sourceCell);
    row.dataset.editable = 'true';
  });
}

function readEditedRows() {
  const grouped = new Map();
  document.querySelectorAll('#matches tr[data-cache-key]').forEach(row => {
    const match = cache.matches[row.dataset.cacheKey];
    if (!match) return;
    if (!grouped.has(match.team)) grouped.set(match.team, []);
    grouped.get(match.team).push(match);
  });

  for (const [team, rows] of grouped.entries()) {
    grouped.set(team, rows.map((row, index) => ({
      ...row,
      weight: Math.pow(0.9, index) * (row.friendly ? 0.55 : 1)
    })));
  }
  return grouped;
}

function refreshModelFromManualData() {
  const grouped = readEditedRows();
  const homeRows = grouped.get(state.homeName) || [];
  const awayRows = grouped.get(state.awayName) || [];
  if (!homeRows.length || !awayRows.length) return;

  const previousOdds = Object.fromEntries(state.markets.map(market => [market.id, market.odds]));
  const homeAggregate = aggregate(homeRows);
  const awayAggregate = aggregate(awayRows);

  state.model = createModel(homeAggregate, awayAggregate);
  state.markets = createMarkets(state.model, state.homeName, state.awayName);
  state.markets.forEach(market => {
    const odd = previousOdds[market.id];
    if (odd != null) {
      market.odds = odd;
      market.ev = marketEV(market, odd);
    }
  });

  state.selected = new Set([...state.selected].filter(id => state.markets.some(market => market.id === id)));

  renderTeam('homeStats', homeAggregate);
  renderTeam('awayStats', awayAggregate);
  document.getElementById('homeCoverage').textContent = `Cobertura: ${homeAggregate.shotsCount}/${homeAggregate.matches} con tiros; ${homeAggregate.sotAgainstCount}/${homeAggregate.matches} con tiros a puerta recibidos; ${homeAggregate.cornersCount}/${homeAggregate.matches} con córners; ${homeAggregate.yellowCount}/${homeAggregate.matches} con tarjetas.`;
  document.getElementById('awayCoverage').textContent = `Cobertura: ${awayAggregate.shotsCount}/${awayAggregate.matches} con tiros; ${awayAggregate.sotAgainstCount}/${awayAggregate.matches} con tiros a puerta recibidos; ${awayAggregate.cornersCount}/${awayAggregate.matches} con córners; ${awayAggregate.yellowCount}/${awayAggregate.matches} con tarjetas.`;
  document.getElementById('confidence').textContent = state.model.confidence;
  document.getElementById('confidence').className = state.model.confidence === 'Media' ? 'good' : state.model.confidence === 'Baja' ? 'bad' : 'warn';
  document.getElementById('xgTotal').textContent = (state.model.homeGoals + state.model.awayGoals).toFixed(2);
  document.getElementById('cardsTotal').textContent = (state.model.homeCards + state.model.awayCards).toFixed(2);
  document.getElementById('topScores').innerHTML = topScores(state.model);

  renderMarkets();
  renderSelectedCombo();
  document.getElementById('comboSuggestions').innerHTML = '';
}

function rememberOriginal(match, field) {
  match.originalValues ||= {};
  if (!(field in match.originalValues)) match.originalValues[field] = match[field] ?? null;
  match.manualFields ||= {};
  match.manualFields[field] = true;
}

function applyManualValue(match, field, value) {
  rememberOriginal(match, field);
  match[field] = value;
  match.cachedAt = Date.now();

  const counterpartEntry = findCounterpart(match);
  const mirroredField = MIRROR_FIELDS[field];
  if (!counterpartEntry || !mirroredField) return;

  const [, counterpart] = counterpartEntry;
  rememberOriginal(counterpart, mirroredField);
  counterpart[mirroredField] = value;
  counterpart.cachedAt = Date.now();
}

function saveManualData() {
  let changed = 0;
  document.querySelectorAll('.match-data-input').forEach(input => {
    const cacheKey = input.dataset.cacheKey;
    const field = input.dataset.field;
    const match = cache.matches[cacheKey];
    if (!match || !EDITABLE_FIELDS.includes(field)) return;

    const nextValue = input.value.trim() === '' ? null : Math.max(0, Math.round(Number(input.value)));
    if (Number.isNaN(nextValue) || match[field] === nextValue) return;

    applyManualValue(match, field, nextValue);
    changed++;
  });

  if (!changed) {
    document.getElementById('manualDataStatus').textContent = 'No hay cambios nuevos que guardar.';
    return;
  }

  saveCache();
  document.querySelectorAll('#matches tr[data-cache-key]').forEach(row => {
    const match = cache.matches[row.dataset.cacheKey];
    const sourceCell = row.lastElementChild;
    if (match?.manualFields && Object.keys(match.manualFields).length && sourceCell) {
      sourceCell.textContent = 'Manual';
      sourceCell.className = 'manual-source edited';
    }
  });

  refreshModelFromManualData();
  document.getElementById('manualDataStatus').textContent = `${changed} valores guardados. El modelo y todos los mercados se han recalculado.`;
}

function resetManualData() {
  let restored = 0;
  document.querySelectorAll('#matches tr[data-cache-key]').forEach(row => {
    const match = cache.matches[row.dataset.cacheKey];
    if (!match?.manualFields || !match.originalValues) return;

    for (const field of Object.keys(match.manualFields)) {
      match[field] = match.originalValues[field] ?? null;
      restored++;
    }
    delete match.manualFields;
    delete match.originalValues;
  });

  if (!restored) {
    document.getElementById('manualDataStatus').textContent = 'No hay datos manuales que restablecer en esta tabla.';
    return;
  }

  saveCache();
  document.querySelectorAll('#matches tr[data-cache-key]').forEach(row => {
    const match = cache.matches[row.dataset.cacheKey];
    row.querySelectorAll('.match-data-input').forEach(input => {
      input.value = match?.[input.dataset.field] ?? '';
    });
    const sourceCell = row.lastElementChild;
    if (sourceCell) {
      sourceCell.textContent = 'API';
      sourceCell.className = 'manual-source';
    }
  });

  refreshModelFromManualData();
  document.getElementById('manualDataStatus').textContent = `${restored} valores restablecidos a la información original.`;
}

const matchesBody = document.getElementById('matches');
if (matchesBody) {
  new MutationObserver(() => queueMicrotask(enhanceDataTable)).observe(matchesBody, { childList: true });
}

enhanceDataTable();
