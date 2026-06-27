'use strict';

// Prevent the odds table from being rebuilt on every keystroke.
// app.js originally calls renderMarkets() inside each input event, which
// replaces the focused input and resets the scroll position.
document.addEventListener('input', event => {
  const input = event.target instanceof Element
    ? event.target.closest('.market-odds')
    : null;

  if (!input) return;

  // Stop the original bubbling listener attached by app.js.
  event.stopImmediatePropagation();
  event.stopPropagation();

  const market = state.markets.find(item => item.id === input.dataset.id);
  if (!market) return;

  market.odds = num(input.value);
  market.ev = marketEV(market, market.odds);

  const row = input.closest('tr');
  const evCell = row?.children?.[5];

  if (evCell) {
    const positive = market.ev != null
      && market.ev > 0.03
      && market.confidence !== 'Baja'
      && market.confidence !== 'Insuficiente';

    evCell.className = positive
      ? 'good'
      : market.ev != null && market.ev < 0
        ? 'bad'
        : '';

    evCell.textContent = market.ev == null ? '—' : pct(market.ev);
  }

  renderSelectedCombo();

  const suggestions = document.getElementById('comboSuggestions');
  if (suggestions) suggestions.innerHTML = '';
}, true);
