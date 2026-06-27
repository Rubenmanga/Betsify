# EDGE2026 — Análisis Matemático de Apuestas WC2026

Herramienta de análisis matemático de apuestas para el Mundial 2026. Funciona directamente desde el navegador, sin instalación ni dependencias externas.

## Acceso rápido

**GitHub Pages:** https://rubenmanga.github.io/betsify/

También puedes descargar `index.html` y abrirlo directamente en cualquier navegador.

## Módulos

### ⚽ Analizar Partido
- Selecciona dos equipos de la base de datos del torneo
- Ajusta fase, motivación, bajas importantes y notas H2H
- El motor Poisson calcula probabilidades para todos los mercados:
  - 1X2, Over/Under 2.5, Ambos Marcan, Hándicap Asiático
  - Córneres (>9.5 / >10.5), Tarjetas (>3.5 / >4.5)
  - Goles en 1ª y 2ª mitad
- Introduce las cuotas de tu bookmaker para ver el **Valor Esperado (EV)** en tiempo real
- Chip verde = EV ≥ 5% | Amarillo = EV positivo | Rojo = EV negativo

### 💰 Bankroll & Kelly
- Calculadora Half-Kelly: introduce probabilidad estimada, cuota y bankroll
- Muestra stake recomendado en € y porcentaje del bankroll
- Fórmulas explicadas: EV, Prob. implícita, Margen casa, Kelly

### 📊 Historial
- Registra tus apuestas (descripción, mercado, cuota, stake)
- Marca resultados WIN/LOSS para calcular ROI automáticamente
- Exporta todo el historial como CSV

### 📚 Guía
- Explicaciones de EV, xG, Poisson, elección de mercados, Kelly y fuentes

## API Key WC2026 (opcional)

La app funciona con datos hardcodeados. Para obtener estadísticas en tiempo real del torneo:

1. Regístrate gratis en [wc2026api.com](https://www.wc2026api.com)
2. Copia tu API key
3. En la app, pulsa el ⚙ (arriba derecha) e introduce la clave
4. La app cacheará las respuestas durante 2 horas para respetar el límite de 100 req/día del plan gratuito

## Motor matemático

```
xG_local   = xGf_local × 0.65 + xGa_visitante × 0.35
xG_visit   = xGf_visit × 0.65 + xGa_local × 0.35

Ajustes:
  Fase final    × 0.85  |  Semifinal × 0.88  |  Cuartos × 0.90
  Octavos       × 0.92  |  R32       × 0.94  |  Grupos  × 1.00
  Motivación alta × 1.08 | baja × 0.88
  Baja clave    × 0.85 (equipo afectado)

Poisson: P(k goles | λ) = e^-λ × λ^k / k!
Matriz 10×10 normalizada → P(1), P(X), P(2), Over/Under, BTTS, AH, etc.
```

## Datos incluidos (sin API)

30 selecciones nacionales con datos xG del torneo:
España, Francia, Alemania, Argentina, Brasil, Portugal, Inglaterra, Holanda, Uruguay, Noruega, México, EEUU, Japón, Suiza, Marruecos, Colombia, Bélgica, Egipto, Turquía, Senegal, Austria, Costa de Marfil, Canadá, Suecia, Australia, Irán, Ecuador, Escocia, Ghana, Paraguay, Corea del Sur.

## Aviso

Esta herramienta es orientativa. Los modelos matemáticos no garantizan beneficios. Apuesta solo lo que puedas permitirte perder y de forma responsable.
