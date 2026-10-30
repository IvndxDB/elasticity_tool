/**
 * Cálculo de Bodesa: ventas + catálogo + competencia → { data, competitor } que consume la app.
 * Módulo puro (sin fs ni S3): recibe el TEXTO de los CSV. Lo usa backend/bodesa/pipeline.js, que los baja de
 *   s3://data-bunker-prod-env/derivables/bodesa/
 *     sell_in_sell_out/Sales_Data_Layout_Bodesa*.csv → ventas mensuales por Codigo Padre y Cadena (20 meses, 740 SKUs)
 *     client/Client.csv                             → catálogo (descripción, marca, EAN)
 *     competitors/bodesa_YYYY-MM-DD.csv             → precios de Liverpool / Elektra / Coppel
 *
 * La elasticidad se calcula AQUÍ (no en la app) porque la venta de Bodesa es muy estacional
 * (Buen Fin / Navidad ≈ 1.7× el promedio, justo con descuentos) y los 3 métodos de la app no
 * controlan eso: confunden temporada con efecto precio. Modelo log-log con efectos fijos:
 *     ln Q[sku,mes] = α[sku] + γ[depto,mes] + E · ln P[sku,mes]
 *   - α[sku]        nivel propio de cada producto
 *   - γ[depto,mes]  temporada de cada departamento (Día de las Madres pesa distinto en
 *                   perfumería que en línea blanca)
 * Se estima por niveles:
 *   1. Departamento: pendiente agrupada, error estándar cluster por SKU. Confiable si E<0 y t≤-2.
 *   2. SKU: pendiente propia (≥12 meses), combinada con la del departamento por shrinkage
 *      bayesiano. Con datos ruidosos solo las pendientes extremas salen significativas por sí
 *      solas (mediana ≈ -4); el shrinkage las jala hacia el departamento según su precisión.
 *   3. Sin señal en ninguno → la app mantiene el precio.
 */
// Las ventas vienen SIN IVA (precio realizado ≈ catálogo/1.16). Se pasan a precio con IVA
// para que sean comparables con catálogo y competencia. Poner 1 si Bodesa confirma lo contrario.
const IVA_FACTOR_VENTAS = 1.16;

// Margen supuesto por departamento (fracción, ej. 0.35) mientras Bodesa no comparta costos.
// Vacío = sin margen: la app no aplica piso de costo ni reglas de margen.
const MARGEN_POR_DEPTO = {};

const MAX_PRICE_RATIO = 2;      // meses con precio > 2× o < ½ del precio típico del SKU se excluyen
const MIN_OBS_PANEL = 6;        // meses mínimos para que un SKU entre a la estimación
const MIN_OBS_SKU = 12;         // meses mínimos para estimar pendiente propia del SKU
const MIN_SKUS_DEPTO = 5;       // SKUs mínimos para estimar un departamento
const T_MIN = 2;                // |t| mínimo para considerar una elasticidad confiable
const ACTIVE_MONTHS = 3;        // un SKU se muestra si vendió en los últimos N meses
const COMP_SNAPSHOTS = 3;       // últimos N cortes de competencia a combinar

// Robust CSV line parser: handles quoted fields containing commas/quotes
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function readCsv(texto) {
  const lines = texto.split(/\r?\n/);
  const header = parseCsvLine(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i] || !lines[i].replace(/,/g, "").trim()) continue; // el layout trae miles de filas ",,,,"
    rows.push(parseCsvLine(lines[i]));
  }
  return { header, rows };
}

function colIndex(header, name) {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`Columna "${name}" no encontrada. Columnas: ${header.join(" | ")}`);
  return i;
}

// normalize UPC: trim, remove leading zeros (so matches between sales and competitor work)
function normUpc(u) {
  if (!u) return "";
  return String(u).replace(/\D/g, "").replace(/^0+/, "");
}

const num = s => parseFloat(String(s || "").replace(/[,$\s]/g, ""));
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

// "ene-25" → "2025-01"
const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };
function toYm(s) {
  const [m, y] = String(s).trim().toLowerCase().split("-");
  if (!MESES[m] || !y) throw new Error(`Mes no reconocido: "${s}"`);
  return `20${y}-${String(MESES[m]).padStart(2, "0")}`;
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * @param {{ cliente: string, ventas: string, competencia: { nombre: string, texto: string }[] }} fuentes
 *   texto de Client.csv, del layout de ventas y de los últimos COMP_SNAPSHOTS cortes de competencia (en orden cronológico)
 * @param {(msg: string) => void} [log]
 * @returns {{ data: object, competitor: object }}
 */
function calcularBodesa(fuentes, log = () => {}) {
  // ── 1. Catálogo: SKU → metadata (se prefiere la fila de LA MARINA, que es la mayoritaria) ──
  const cat = readCsv(fuentes.cliente);
  const cc = {
    sku: colIndex(cat.header, "SKU"),
    des: colIndex(cat.header, "Descripción SKU"),
    ean: colIndex(cat.header, "EAN"),
    eanWm: colIndex(cat.header, "EAN WM"),
    brand: colIndex(cat.header, "Marca"),
    store: colIndex(cat.header, "Dirección Comercial"),
    price: colIndex(cat.header, "Precio con IVA"),
  };
  const catalog = {};
  for (const r of cat.rows) {
    const sku = (r[cc.sku] || "").trim();
    if (!sku) continue;
    if (catalog[sku] && (r[cc.store] || "").trim() !== "LA MARINA") continue;
    catalog[sku] = {
      sku_des: (r[cc.des] || "").trim(),
      brand: (r[cc.brand] || "").trim(),
      upc: normUpc(r[cc.ean]),
      upcWm: normUpc(r[cc.eanWm]),
      listPrice: num(r[cc.price]) || null,
    };
  }
  log(`Catálogo: ${Object.keys(catalog).length} SKUs`);

  // ── 2. Ventas: Codigo Padre × mes (se suman las cadenas; solo ~2% de SKUs está en ambas) ──
  const sales = readCsv(fuentes.ventas);
  // Año natural/Mes, Cadena, Categoria/Departamento, LM Gerencia, EB Gerencia, Grupo, Codigo Padre, Venta en piezas, Venta en pesos
  const [iMes, iCadena, iDepto, , , iGrupo, iSku, iPz, iMx] = sales.header.map((_, i) => i);
  const skuMonth = {}; // sku -> { ym -> { units, revenue } }
  const skuMeta = {};
  const chainUnits = {}; // sku -> { cadena -> piezas }, para quedarse con la cadena principal
  let returns = 0;
  for (const r of sales.rows) {
    const sku = (r[iSku] || "").trim();
    const pz = num(r[iPz]);
    const mx = num(r[iMx]);
    if (!sku || !(pz > 0) || !(mx > 0)) { returns++; continue; }
    const ym = toYm(r[iMes]);
    if (!skuMonth[sku]) skuMonth[sku] = {};
    const rec = skuMonth[sku][ym] || (skuMonth[sku][ym] = { units: 0, revenue: 0 });
    rec.units += pz;
    rec.revenue += mx * IVA_FACTOR_VENTAS;
    const cadena = (r[iCadena] || "").trim();
    chainUnits[sku] = chainUnits[sku] || {};
    chainUnits[sku][cadena] = (chainUnits[sku][cadena] || 0) + pz;
    if (!skuMeta[sku]) {
      skuMeta[sku] = {
        department: (r[iGrupo] || "").trim(),
        category: (r[iDepto] || "").trim(),
      };
    }
  }
  for (const sku of Object.keys(skuMeta)) {
    // La app usa fesa_classification como filtro "Clasificación": aquí es la cadena principal
    skuMeta[sku].fesa_classification = Object.entries(chainUnits[sku]).sort((a, b) => b[1] - a[1])[0][0];
  }
  const allMonths = [...new Set(Object.values(skuMonth).flatMap(m => Object.keys(m)))].sort();
  log(`Ventas: ${Object.keys(skuMonth).length} SKUs, ${allMonths.length} meses (${allMonths[0]} a ${allMonths[allMonths.length - 1]}), ${returns} filas sin venta/devoluciones excluidas`);

  // ── 3. Elasticidad: panel log-log con efectos fijos SKU + departamento×mes ──
  const obs = [];
  for (const sku of Object.keys(skuMonth)) {
    const pts = Object.entries(skuMonth[sku]).map(([ym, r]) => ({ ym, lq: Math.log(r.units), lp: Math.log(r.revenue / r.units) }));
    const medLp = median(pts.map(p => p.lp));
    const kept = pts.filter(p => Math.abs(p.lp - medLp) <= Math.log(MAX_PRICE_RATIO));
    if (kept.length < MIN_OBS_PANEL) continue;
    for (const p of kept) obs.push({ sku, dept: skuMeta[sku].category, ...p });
  }

  // Quita efectos fijos SKU y mes dentro de un departamento (proyecciones alternadas)
  function demeanTwoWay(rows) {
    for (const r of rows) { r.y = r.lq; r.x = r.lp; }
    for (let it = 0; it < 100; it++) {
      let moved = 0;
      for (const key of ["sku", "ym"]) {
        const acc = {};
        for (const r of rows) {
          const a = acc[r[key]] || (acc[r[key]] = { y: 0, x: 0, n: 0 });
          a.y += r.y; a.x += r.x; a.n++;
        }
        for (const r of rows) {
          const a = acc[r[key]];
          const dy = a.y / a.n, dx = a.x / a.n;
          r.y -= dy; r.x -= dx;
          moved = Math.max(moved, Math.abs(dy), Math.abs(dx));
        }
      }
      if (moved < 1e-9) break;
    }
  }

  const byDept = {};
  for (const o of obs) (byDept[o.dept] || (byDept[o.dept] = [])).push(o);

  const segmentElasticity = {};
  const rawSku = {}; // sku -> { elasticity, se, n, r2 } pendiente propia antes del shrinkage
  for (const dept of Object.keys(byDept)) {
    const rows = byDept[dept];
    const skus = [...new Set(rows.map(r => r.sku))];
    if (skus.length < MIN_SKUS_DEPTO) continue;
    demeanTwoWay(rows);

    // Departamento: pendiente agrupada + error estándar cluster por SKU
    let Sxx = 0, Sxy = 0, Syy = 0;
    for (const r of rows) { Sxx += r.x * r.x; Sxy += r.x * r.y; Syy += r.y * r.y; }
    if (Sxx < 1e-9) continue;
    const b = Sxy / Sxx;
    const cl = {};
    for (const r of rows) cl[r.sku] = (cl[r.sku] || 0) + r.x * (r.y - b * r.x);
    const G = skus.length;
    const se = Math.sqrt(Object.values(cl).reduce((s, u) => s + u * u, 0) * G / (G - 1)) / Sxx;
    segmentElasticity[dept] = {
      elasticity: round(b, 3), se: round(se, 3), t: round(b / se, 1), n: G, obs: rows.length,
      r2: round(Syy > 0 ? (b * Sxy) / Syy : 0, 4),
      reliable: b < 0 && b / se <= -T_MIN,
    };

    // SKU: pendiente propia sobre los residuales del departamento
    for (const sku of skus) {
      const rs = rows.filter(r => r.sku === sku);
      if (rs.length < MIN_OBS_SKU) continue;
      let xx = 0, xy = 0, yy = 0;
      for (const r of rs) { xx += r.x * r.x; xy += r.x * r.y; yy += r.y * r.y; }
      if (xx < 1e-6) continue; // sin variación de precio propia
      const bs = xy / xx;
      const sse = Math.max(0, yy - bs * xy);
      rawSku[sku] = { elasticity: bs, se: Math.sqrt(sse / (rs.length - 2) / xx), n: rs.length, r2: yy > 0 ? (bs * xy) / yy : 0 };
    }
  }

  // Shrinkage: prior = elasticidad del departamento si es confiable, si no 0 ("sin efecto").
  // τ² (dispersión real entre SKUs) por método de momentos sobre los SKUs de deptos confiables.
  const priorOf = sku => { const s = segmentElasticity[skuMeta[sku].category]; return s?.reliable ? s.elasticity : 0; };
  const devs = Object.keys(rawSku).filter(s => segmentElasticity[skuMeta[s].category]?.reliable)
    .map(s => (rawSku[s].elasticity - priorOf(s)) ** 2 - rawSku[s].se ** 2);
  const tau2 = Math.max(0.1, devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : 0.1);

  const estimates = {}; // sku -> estimación final que usa la app
  for (const sku of Object.keys(skuMeta)) {
    const seg = segmentElasticity[skuMeta[sku].category];
    const raw = rawSku[sku];
    if (raw) {
      const prior = priorOf(sku);
      const prec = 1 / raw.se ** 2 + 1 / tau2;
      const e = (raw.elasticity / raw.se ** 2 + prior / tau2) / prec;
      const se = Math.sqrt(1 / prec);
      // Con depto confiable el prior ya es informativo: basta con que sea negativa.
      // Con prior 0 (depto sin señal) el SKU tiene que demostrar efecto por sí solo.
      const reliable = e < 0 && (seg?.reliable || e / se <= -T_MIN);
      if (reliable) {
        estimates[sku] = {
          level: "sku", elasticity: round(e, 3), se: round(se, 3), t: round(e / se, 1), n: raw.n, r2: round(raw.r2, 4),
          raw: { elasticity: round(raw.elasticity, 3), se: round(raw.se, 3) },
          ownWeight: round((1 / raw.se ** 2) / prec, 2), // peso de los datos propios vs. el prior del depto
          prior,
        };
        continue;
      }
    }
    if (seg?.reliable) estimates[sku] = { level: "segment" };
  }
  const nSku = Object.values(estimates).filter(e => e.level === "sku").length;
  const nSeg = Object.values(estimates).filter(e => e.level === "segment").length;
  log(`Elasticidad: ${Object.keys(segmentElasticity).length} deptos estimados, ${Object.values(segmentElasticity).filter(s => s.reliable).length} confiables; ` +
    `τ=${Math.sqrt(tau2).toFixed(2)}; SKUs con pendiente propia ${Object.keys(rawSku).length} → ${nSku} usan la suya, ${nSeg} la del depto`);

  // ── 4. Productos (SKUs con venta en los últimos meses) ──
  const activeFrom = allMonths[Math.max(0, allMonths.length - ACTIVE_MONTHS)];
  const products = [];
  for (const sku of Object.keys(skuMonth)) {
    if (!Object.keys(skuMonth[sku]).some(ym => ym >= activeFrom)) continue;
    const meta = skuMeta[sku];
    const c = catalog[sku];
    const margin = MARGEN_POR_DEPTO[meta.category] || 0;
    const series = allMonths.filter(ym => skuMonth[sku][ym]).map(ym => {
      const r = skuMonth[sku][ym];
      return { month: ym, units: Math.round(r.units), price: round(r.revenue / r.units, 2), margin };
    });
    products.push({
      sku,
      sku_des: c?.sku_des || `${meta.category} · cód. ${sku}`,
      ...meta,
      brand: c?.brand || "",
      upc: c?.upc || "",
      listPrice: c?.listPrice || null,
      totalUnits: series.reduce((s, d) => s + d.units, 0),
      avgPrice: round(series.reduce((s, d) => s + d.price, 0) / series.length, 2),
      estimate: estimates[sku] || null,
      series,
    });
  }
  products.sort((a, b) => b.totalUnits - a.totalUnits);
  const byLevel = lvl => products.filter(p => (p.estimate?.level || null) === lvl).length;
  log(`Productos: ${products.length} activos (venta desde ${activeFrom}): ${byLevel("sku")} elasticidad propia, ${byLevel("segment")} del depto, ${byLevel(null)} sin señal`);

  // ── 5. Competencia: últimos cortes, cruce por EAN sin dígito verificador (EAN WM ↔ upc wm) ──
  const compFiles = fuentes.competencia.map(x => x.nombre); // ya vienen en orden cronológico (pipeline.js)
  const wmToUpc = {};
  for (const p of products) {
    const c = catalog[p.sku];
    if (c?.upcWm && c.upc) wmToUpc[c.upcWm] = c.upc;
  }
  const byUpc = {};
  for (const f of compFiles) { // orden cronológico: el corte más reciente sobrescribe por canal
    const comp = readCsv(fuentes.competencia.find(x => x.nombre === f).texto);
    const g = name => comp.header.indexOf(name);
    const ix = { wm: g("upc wm"), canal: g("canal"), fp: g("final price"), price: g("price"), url: g("url sku"), image: g("image"), brand: g("marca"), item: g("item") };
    for (const r of comp.rows) {
      const upc = wmToUpc[normUpc(r[ix.wm])];
      if (!upc) continue;
      const canal = (r[ix.canal] || "").trim();
      const price = num(r[ix.fp]) || num(r[ix.price]);
      if (!canal || !(price > 0)) continue;
      const rec = byUpc[upc] || (byUpc[upc] = { upc, image: "", item: "", brand: "", byCanal: {} });
      const image = (r[ix.image] || "").trim();
      if (/^https?:\/\//.test(image)) rec.image = image;
      if (r[ix.item]) rec.item = r[ix.item].trim();
      if (r[ix.brand]) rec.brand = r[ix.brand].trim();
      const prev = rec.byCanal[canal];
      // dentro del mismo corte se queda el más barato; un corte más nuevo reemplaza al anterior
      if (!prev || prev.file !== f || price < prev.price) {
        rec.byCanal[canal] = { canal, price: round(price, 2), url: (r[ix.url] || "").trim(), brand: rec.brand, file: f };
      }
    }
  }
  const competitor = {};
  for (const upc of Object.keys(byUpc)) {
    const rec = byUpc[upc];
    const comps = Object.values(rec.byCanal).map(({ file, ...c }) => c).sort((a, b) => a.price - b.price);
    const prices = comps.map(c => c.price);
    competitor[upc] = {
      upc,
      image: rec.image || null,
      item: rec.item || null,
      brand: rec.brand || null,
      competitors: comps,
      minPrice: prices[0],
      avgPrice: round(prices.reduce((a, b) => a + b, 0) / prices.length, 2),
      maxPrice: prices[prices.length - 1],
    };
  }
  log(`Competencia: ${Object.keys(competitor).length} productos con precio de competidor (cortes: ${compFiles.join(", ")})`);

  return {
    // classificationLabel: la app muestra fesa_classification como selector de "Cadena" (El Bodegón / La Marina)
    data: { generated: new Date().toISOString(), client: "Bodesa", classificationLabel: "Cadena", months: allMonths, segmentElasticity, products },
    competitor,
  };
}

module.exports = { calcularBodesa, COMP_SNAPSHOTS };
