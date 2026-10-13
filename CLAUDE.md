# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

Dashboard de análisis de elasticidad-precio para un portafolio de SKUs de farmacia (FESA). Calcula la elasticidad de cada producto por 3 métodos, recomienda un precio óptimo, y ofrece herramientas de simulación, reglas de negocio, clustering ABC, canibalización y auditoría. UI 100% en español.

## Estructura de dos capas

El repo tiene dos partes separadas:

1. **Raíz** (`/`): scripts de preprocesamiento en Node + los CSV crudos de origen (grandes: `sales_data_fesa.csv` ≈192 MB, `fesa_2026-04-17.csv` ≈46 MB). Estos scripts transforman los CSV en JSON que consume el frontend.
2. **`app/`**: aplicación Vite + React 19 que lee únicamente los JSON pre-procesados. **El frontend nunca lee los CSV crudos** — solo `app/public/data.json` y `app/public/competitor.json`.

`dashboard_original.jsx`, `tablero_diseño.png` y `layout-agent.xlsx` son referencias de diseño, no código en uso.

## Comandos

Preprocesamiento (desde la raíz — son **CommonJS** con `require`, mientras que `app/` es ESM; ejecútalos con `node` directo, no dentro de `app/`):
```bash
node preprocess.js              # sales_data_fesa.csv  → app/public/data.json
node preprocess_competitor.js   # fesa_2026-04-17.csv  → app/public/competitor.json
```

App (desde `app/`):
```bash
npm install
npm run dev       # Vite dev server. El launch config usa --port 5174 --strictPort
npm run build     # build de producción
npm run lint      # ESLint (flat config, eslint.config.js)
npm run preview
```

No hay framework de tests configurado.

Si cambian los CSV crudos, hay que **re-correr los scripts de preprocess** y volver a construir: los `.json` en `app/public/` son artefactos generados, no fuentes editables a mano.

## Flujo de datos

```
sales_data_fesa.csv ──preprocess.js──────────→ data.json ─┐
                                                           ├─→ App.jsx (fetch en mount)
fesa_2026-04-17.csv ──preprocess_competitor.js→ competitor.json ─┘
```

- **`preprocess.js`** agrega filas semanales a nivel **SKU × mes** (precio ponderado por unidades, margen ponderado). Solo incluye SKUs con **≥3 meses** de datos. Salida: `{ generated, months[], products[{ sku, sku_des, department, category, upc, ..., series: [{month, units, price, margin}] }] }`.
- **`preprocess_competitor.js`** agrupa precios de competidores por **UPC normalizado**, deduplicando por canal (se queda con el precio más bajo por canal). Salida: mapa `upc → { competitors[], minPrice, avgPrice, maxPrice, image }`.

### La llave de unión es el UPC normalizado
El join entre ventas y competencia se hace por UPC. La función `normUpc` (quita todo lo no-dígito y ceros a la izquierda) está **duplicada idénticamente en los 3 archivos** (`preprocess_competitor.js`, `App.jsx`, y el matcheo de subida de CSV). Si modificas la normalización, cámbiala en los tres o el join se rompe silenciosamente.

## Motor de cálculo — `app/src/elasticity.js`

Módulo puro (sin React) con la lógica de negocio central. Cambios en la matemática de elasticidad/precio van aquí, no en `App.jsx`.

- **3 métodos**: `olsElasticity` (Q=a+bP, E=b·P̄/Q̄), `logLogElasticity` (ln Q sobre ln P, la pendiente ES la elasticidad), `arcElasticity` (punto medio promedio de pares consecutivos).
- **`analyzeElasticity(series)`** corre los 3 y elige el mejor por **menor MAPE** (empate → menor RMSE). Devuelve `{ results, best }`.
- **`suggestPrice`** busca el precio que **maximiza ingreso** dentro de una banda ±30% (piso en costo·1.05 si se conoce margen), bajo demanda de elasticidad constante. NO usa la regla de Lerner ingenua (ver comentario extenso en el archivo: empujaba precios al lado incorrecto para productos elásticos).
- **`sanitizeElasticity`** acota a `[-4, -0.05]`; elasticidad **positiva o cero → 0** (se trata como "sin señal confiable" y se mantiene el precio). Convención de signo: negativo = producto normal.

## Frontend — `app/src/App.jsx`

**Es un monolito de ~3600 líneas.** Casi toda la UI y el estado viven en el componente `App`, más helpers a nivel de módulo (arriba del archivo) y dos subcomponentes al final (`RuleBuilder`, `ClusterPopup`). No busques archivos de componentes separados — no existen.

Organizado en **10 tabs** (array `tabs` cerca de la línea 847): `elasticity`, `comparison`, `portfolio` ("Sugerencia de Precios"), `scenarios` ("Simulador"), `impact`, `canib` (canibalización), `clusters`, `rules`, `audit`, `glossary`. Cada tab es un bloque `{tab === "..." && (...)}` en el JSX.

Conceptos clave del estado (todo en memoria de React; **nada persiste** salvo `currentUser` en `localStorage`):

- **`allAnalysis`** (useMemo): `sku → analyzeElasticity(...)` para todo el portafolio. Es la base de casi todo lo demás.
- **`portfolioData`** (useMemo): fila enriquecida por SKU con precio actual, sugerido, `pctChange`, unidades proyectadas, nuevo margen, confianza, etc. Es la fuente de las tablas y descargas CSV.
- **Familias** (`familyRules`, `familyAggregates`, `familySuggest`): agrupan SKUs (ej. sabores de un mismo producto). La elasticidad se calcula sobre la serie **agregada** de la familia, y **todos los SKUs de la familia reciben el MISMO precio absoluto** (no el mismo %), porque en tienda deben costar igual.
- **Escenarios** (`SCENARIOS`, `scenario`): overrides sobre las reglas globales (agresivo/conservador/mantener margen/congelar). `effectiveGlobalRules` = escenario aplicado sobre `businessRules`.
- **Reglas de negocio** (`applyBusinessRules`): cap de % de cambio, margen mín/máx, precio vs. competidor. Precedencia: **familia > escenario > global**.
- **Aprobaciones / overrides** (`approvals`, `overrides`): decisión por SKU y precio manual. Un CSV con columnas `upc` y `price` puede subirse para setear overrides masivos (`handlePortfolioUpload`).
- **Clustering**: `abcClassify` (ABC por Pareto de revenue) y `kmeans` (helpers de módulo) alimentan el tab de clusters.

`ErrBoundary` (clase) envuelve tabs propensos a fallar por datos.

## Notas de contexto

- Los `settings.local.json` y `launch.json` contienen rutas absolutas de una máquina anterior (`C:\Users\DiegoSosa\...`) y una app derivada (`farmacias_herrera_calculadora_precios`). La ruta de trabajo actual es `elasticity_dashboard` bajo el usuario actual — ignora las rutas viejas.
- La marca en el header es **Data Bunker** (data-bunker.ai); la paleta de colores está hardcodeada en el objeto `C` al inicio de `App.jsx`.
