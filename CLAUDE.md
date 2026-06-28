# Betsify — CLAUDE.md

Web app de análisis matemático de apuestas deportivas. Motor Poisson + Dixon-Coles + xG real + ponderación ClubElo. Sin frameworks, sin dependencias de build.

## Repositorio

- **GitHub**: https://github.com/Rubenmanga/Betsify (rama `main`)
- **URL pública**: https://rubenmanga.github.io/betsify/
- **Deploy**: Vercel, automático desde `main` — no usar `vercel dev` ni preview local

## Stack

| Capa | Tecnología |
|------|------------|
| Frontend | HTML + CSS + JS vanilla (sin build step) |
| Backend | Vercel Serverless Functions (Node, ESM) |
| Datos live | ESPN API, Sofascore, ClubElo |
| Deploy | Vercel (`vercel.json` → `cleanUrls: true`) |

## Estructura de archivos

```
index.html          # UI completa (tabla de partidos, dropdowns, cards de mercados)
app.js              # Toda la lógica: fetch, modelo, renderizado
styles.css          # Estilos
api/
  espn.js           # Proxy → ESPN API (modos: scoreboard, schedule, summary)
  sofascore.js      # Proxy → Sofascore (modos: search, events, stats) — cache 1h
  clubelo.js        # Proxy → ClubElo CSV API — cache 24h
data/               # JSON de test estático (Croatia/Ghana)
scraper/            # Script Python fbref (no está integrado en la app)
```

## Modelo matemático

### Parámetros base

```js
const DC_RHO = -0.13;           // Dixon-Coles (1997) — correlación scores bajos
const ELO_BASELINE = 1500;      // Referencia Elo internacional
const ELO_CLAMP_MIN = 0.6;
const ELO_CLAMP_MAX = 1.4;
const INTERNATIONAL_GOAL_PRIOR = 1.25;
const INTERNATIONAL_CARD_PRIOR = 1.85;
```

### Pipeline de cálculo (app.js)

1. **`teamData()`** — fetcha los últimos partidos del equipo vía ESPN
2. **`enrichRowsWithElo()`** — para cada partido, obtiene Elo del rival en esa fecha (ClubElo API) y ajusta el peso: `weight = 0.9^i * (friendly ? 0.55 : 1) * rivalEloFactor(rivalElo)`
3. **`enrichTeam()`** — fetcha xG de los últimos 10 partidos del equipo vía Sofascore
4. **`aggregate()`** — pondera goles/tarjetas/corners; usa xG como lambda base cuando hay ≥5 partidos con cobertura
5. **`createModel()`** — calcula λ_home, λ_away, lambdas de tarjetas/corners
6. **`matrix()`** — distribución de Poisson con corrección Dixon-Coles `tau()` para scores 0-0/1-0/0-1/1-1; normaliza matriz a suma 1.0
7. **`calcMarkets()`** — genera los 10 mercados (1X2, O/U, BTTS, hándicap, corners, tarjetas) con EV

### Caché

- `localStorage` (`CACHE_KEY = 'betsify_compact_cache_v5'`) — hasta 300 matches, TTL de sesión
- Vercel Edge Cache: `sofascore.js` → 1h, `espn.js summary` → 24h, `clubelo.js` → 24h
- `state.clubelo` — mapa en memoria por equipo para evitar refetch dentro de la misma sesión

## Fases implementadas

| Fase | Estado | Descripción |
|------|--------|-------------|
| A | ✅ Completa | Dixon-Coles + normalización de matriz |
| B | ✅ Completa | xG real desde Sofascore como lambda base |
| C | ✅ Completa | Ponderación de partidos históricos por Elo del rival (ClubElo) |

## Cómo hacer cambios

### Reglas estrictas

- **No introducir npm, bundler, ni dependencias de build** — el proyecto no tiene `package.json` ni `node_modules`
- **No dividir `app.js`** en módulos ESM de frontend sin probar que el browser los cargue (actualmente es un único script `defer`)
- **No usar `import` en `index.html`** — el script se carga con `<script src="app.js" defer>`
- **Las serverless functions usan ESM** (`export default async function handler`) — no cambiar a CommonJS
- **Después de cada cambio, desplegar a Vercel producción** (no preview)

### Flujo de desarrollo

```
1. Editar index.html / app.js / api/*.js
2. Verificar que no se rompe la carga offline (fallback hardcodeado)
3. git add -p → commit con tipo convencional (feat/fix/perf/refactor)
4. git push origin main → Vercel despliega automáticamente
```

### Añadir un nuevo mercado

1. En `calcMarkets()` (app.js) — añadir entrada al array `markets`
2. En `renderMarkets()` — incluir la nueva entrada en el renderizado
3. Verificar que EV se calcula correctamente contra cuotas reales

### Modificar el modelo

- Cambiar `DC_RHO` en la constante global afecta `scoreMatrix` y `firstHalfMatrix`; `cardMatrix` usa `rho=0` explícitamente
- Si se cambia el peso de recencia (`Math.pow(0.9, index)`), verificar que `enrichRowsWithElo` recalcula el campo `weight` correctamente (no el peso por defecto del `teamData`)

## APIs externas

| API | URL | Auth | Límite |
|-----|-----|------|--------|
| ESPN | `site.api.espn.com/apis/site/v2/sports/soccer` | Ninguna | Sin límite conocido |
| Sofascore | `api.sofascore.com` (via proxy) | Ninguna | Bloquea IPs si se abusa |
| ClubElo | `api.clubelo.com/{TeamName}` | Ninguna | CSV libre, cache 24h |
| wc2026api.com | (externa, config usuario) | API key opcional | 100 req/día plan free |

## Seguridad en proxies

- `api/espn.js` valida `league` y `team` con regex antes de interpolar en URLs (`SAFE_LEAGUE`, `SAFE_ID`)
- `api/sofascore.js` y `api/clubelo.js` usan `encodeURIComponent` en parámetros de usuario
- No exponer ninguna API key en frontend — si se añade una, usar variables de entorno Vercel

## Tests

No hay suite de tests automatizados. Verificación manual:

- [ ] Partido con xG disponible → lambda usa xG, no goals
- [ ] Partido sin xG → lambda usa goals ponderados (fallback correcto)
- [ ] Rival con Elo alto → `rivalEloFactor > 1.0`
- [ ] Rival sin datos ClubElo → `rivalEloFactor = 1` (neutro, sin romper)
- [ ] Offline / sin API key → app carga con datos hardcodeados
- [ ] `scoreMatrix` suma ≈ 1.0 (normalización)
