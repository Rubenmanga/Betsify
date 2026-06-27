# EDGE2026 — Análisis matemático de apuestas WC2026

Web app de análisis de apuestas para el Mundial 2026. Motor matemático basado en xG real y distribución de Poisson. Sin frameworks, sin dependencias, funciona offline.

## URL pública

**https://rubenmanga.github.io/betsify/**

## Características

- **Motor Poisson**: calcula probabilidades 1X2, Over/Under, BTTS, Hándicap Asiático, Corners y Tarjetas
- **xG real**: datos del torneo (API + fallback hardcodeado con datos reales de RealGM xG Tracker)
- **10 mercados** con Valor Esperado calculado y chips de color (verde ≥5%, amarillo ≥0%, rojo negativo)
- **Bankroll & Medio Kelly**: calcula stake óptimo según tu bankroll
- **Historial**: registra apuestas, marca WIN/LOSS, calcula ROI acumulado, exporta CSV
- **Guía**: EV, Poisson, gestión de bankroll, fuentes de datos
- **Caché**: respuestas API guardadas 2h en localStorage (límite 100 req/día en plan free)
- **Offline**: si no hay API key o falla la conexión, usa base de datos hardcodeada de 35 equipos

## Cómo usarlo

1. Abre la URL en el navegador (funciona también abriendo `index.html` directamente)
2. Toca el engranaje ⚙ arriba a la derecha para configurar tu API key (opcional)
3. Selecciona dos equipos y pulsa **Calcular análisis**
4. Introduce las cuotas de la casa y pulsa **Calcular EV**
5. Los mercados aparecen ordenados de mayor a menor valor esperado

## API Key (opcional)

Consigue tu clave gratuita en [wc2026api.com](https://www.wc2026api.com).  
Plan gratuito: 100 peticiones/día. La app funciona sin key usando datos de fallback.

## Partidos analizables — Últimas jornadas grupos J, K, L

| Grupo | Partido | Estado |
|-------|---------|--------|
| K | Portugal vs Colombia | Disponible |
| J | Argentina / Austria / Argelia / Jordania | Disponible |
| L | Inglaterra / Ghana / Croacia / Panamá | Disponible |

Selecciona cualquier combinación en los dropdowns.

## Stack

HTML + CSS + JavaScript vanilla en un único `index.html`. Sin librerías externas.

## Fuentes de datos

- xG reales: RealGM xG Tracker / xgscore.io
- Stats en vivo: [wc2026api.com](https://www.wc2026api.com)
- Cuotas históricas: oddsportal.com · betexplorer.com
