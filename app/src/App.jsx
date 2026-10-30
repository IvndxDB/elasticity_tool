import { useState, useMemo, useEffect, useCallback, Component } from "react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, ComposedChart, Area, ScatterChart, Scatter, Cell, LabelList, ReferenceLine, ReferenceArea, ZAxis,
} from "recharts";
import Papa from "papaparse";
import { analyzeElasticity, suggestPrice, sanitizeElasticity } from "./elasticity";
import { Buscador, CURVA, Filtros, Pills, Sel, Sprint, TemaBoton, brillo, useTemaAnimado } from "./ui/shell";

/* ── Colores: tokens --db-* del sistema Glass & Depth (claro/oscuro en ui/db-ui.css) ── */
const C = {
  navy: "var(--db-ink)", blue: "var(--db-primary)", mid: "var(--db-accent-ink)", light: "var(--db-accent)",
  accent: "var(--db-warn)", green: "var(--db-pos)", red: "var(--db-neg)",
  bg: "var(--db-canvas)", card: "var(--db-surface-hi)", border: "var(--db-hair-2)",
  text: "var(--db-ink)", sub: "var(--db-ink-2)", muted: "var(--db-ink-3)",
};

// Paleta categórica de las gráficas (misma que Pricing L'Oréal), como variables CSS para que cambie con el tema
const METHOD_COLORS = { ols: "var(--elc-own)", loglog: "var(--elc-5)", arc: "var(--elc-1)", sku_fe: "var(--elc-2)", segment: "var(--elc-6)" };

/* ── Cliente: ?cliente=bodesa pide sus datos a la API (backend/, que los baja de S3); sin parámetro, FESA desde /public ── */
const CLIENT = (new URLSearchParams(window.location.search).get("cliente") || "").replace(/[^a-z0-9_-]/gi, "");
const DATA_BASE = CLIENT ? `/api/${CLIENT}/` : "/";
const REINTENTO_MS = 10000; // la API responde 503 mientras genera el dataset por primera vez

/* ── Escenarios de precios: cada uno es un override de las reglas globales ── */
const SCENARIOS = {
  balanced: {
    label: "⚖️ Balanceado (default)",
    desc: "Usa las reglas de negocio tal como están configuradas globalmente. Este es el escenario base.",
    rules: null,
  },
  aggressive: {
    label: "🚀 Agresivo (maximizar ingreso)",
    desc: "Permite cambios de precio de hasta ±30%, ignora el margen mínimo. Objetivo: maximizar ingreso total ignorando protecciones conservadoras.",
    rules: { maxPctChange: 30, minMarginPct: null, maxMarginPct: null, priceAboveCompMin: null },
  },
  conservative: {
    label: "🛡️ Conservador (mínimo riesgo)",
    desc: "Limita los cambios de precio a ±5% del actual y exige margen mínimo ≥ margen actual medio. Ideal para ejecutar cambios graduales.",
    rules: { maxPctChange: 5, minMarginPct: 10, maxMarginPct: null, priceAboveCompMin: 3 },
  },
  keep_margin: {
    label: "💼 Mantener margen",
    desc: "No reduce el margen por debajo del actual. Útil cuando la prioridad es preservar rentabilidad unitaria.",
    rules: { maxPctChange: 20, minMarginPct: 20, maxMarginPct: null },
  },
  hold_price: {
    label: "⏸️ Mantener precios (simulación)",
    desc: "Congela todos los precios en el actual. Sirve de línea base para comparar qué pasa si NO cambias nada.",
    rules: { maxPctChange: 0 },
  },
};

/* ── Helpers ── */
const fmtInt = (n) => Math.round(n).toLocaleString("es-MX");
const fmtMoney = (n, signed = false) => `${n < 0 ? "−" : signed && n > 0 ? "+" : ""}$${Math.abs(Math.round(n)).toLocaleString("es-MX")}`;
const fmtPrice = (n) => `$${(n || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (x, d = 1, signed = false) => x === null || !isFinite(x) ? "—" : `${signed && x > 0 ? "+" : ""}${x.toFixed(d)}%`;
const fmtCompact = (n) => `${n < 0 ? "−" : ""}$${new Intl.NumberFormat("es-MX", { notation: "compact", maximumFractionDigits: 1 }).format(Math.abs(n))}`;
const fmtMonth = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1).toLocaleDateString("es-MX", { month: "short", year: "numeric" }).replace(".", ""); };
const fmtRange = (ms) => ms.length === 1 ? fmtMonth(ms[0]) : `${fmtMonth(ms[0])} – ${fmtMonth(ms[ms.length - 1])}`;

function downloadCSV(rows, filename) {
  const csv = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function normUpc(u) {
  if (!u) return "";
  return String(u).replace(/\D/g, "").replace(/^0+/, "");
}

// Interpretación del coeficiente de elasticidad
function interpretElasticity(e) {
  if (e === null || e === undefined || !isFinite(e)) return { label: "Sin datos", color: C.muted, explanation: "No hay suficiente información para calcular elasticidad." };
  if (e > 0) return { label: "Atípica (Giffen)", color: C.accent, explanation: "Elasticidad positiva: la demanda sube cuando el precio sube. Puede deberse a productos de prestigio, cambios de demanda estacional o ruido en los datos." };
  const ae = Math.abs(e);
  if (ae < 0.2) return { label: "Perfectamente inelástica", color: C.green, explanation: "La demanda prácticamente no responde al precio. Puedes subir el precio con muy bajo riesgo de perder volumen." };
  if (ae < 1) return { label: "Inelástica", color: C.green, explanation: "La demanda responde menos que proporcionalmente al precio (|E|<1). Subir el precio aumenta el ingreso total." };
  if (Math.abs(ae - 1) < 0.05) return { label: "Elasticidad unitaria", color: C.accent, explanation: "Un cambio % en precio provoca igual cambio % en demanda. El ingreso no cambia; se recomienda mantener precio." };
  if (ae < 2) return { label: "Elástica", color: C.red, explanation: "La demanda responde más que proporcionalmente al precio (|E|>1). Bajar el precio incrementa ingreso; subir lo reduce." };
  return { label: "Muy elástica", color: C.red, explanation: "Cambios pequeños en el precio generan cambios grandes en la demanda (|E|>2). Máxima sensibilidad: ajusta con cuidado." };
}

// Clientes con elasticidad pre-calculada en el preprocess (Bodesa: log-log con efectos fijos de
// SKU y de mes por departamento). Reemplaza a los 3 métodos, que no controlan estacionalidad y
// confunden Buen Fin / Navidad con efecto precio. Prioridad: SKU (con shrinkage al depto) >
// departamento > sin análisis (mantener precio). `segment` se conserva para explicarlo en el detalle.
function precomputedAnalysis(p, segments) {
  const seg = segments[p.category];
  const segment = seg ? { ...seg, name: p.category } : null;
  const est = p.estimate;
  const results = [];
  if (est?.level === "sku") {
    results.push({
      method: "SKU sin estacionalidad",
      id: "sku_fe",
      elasticity: est.elasticity,
      r2: est.r2,
      rmse: null,
      mae: null,
      mape: null,
      confidence: est.ownWeight >= 0.5
        ? { level: "alta", reco: "auto_approve", label: "Alta — elasticidad propia", color: "var(--db-pos)" }
        : { level: "media", reco: "review", label: "Media — propia + depto.", color: "var(--db-warn)" },
      description: `Log-log con efectos fijos de SKU y de mes por departamento (${est.n} meses). Pendiente propia ${est.raw.elasticity} (±${est.raw.se}) combinada con ${est.prior ? `la del depto. (${est.prior})` : "un prior de 0"}: ${Math.round(est.ownWeight * 100)}% datos propios. Error ±${est.se}.`,
    });
  }
  if (est && seg?.reliable) {
    results.push({
      method: "Panel por departamento",
      id: "segment",
      elasticity: seg.elasticity,
      r2: seg.r2,
      rmse: null,
      mae: null,
      mape: null,
      confidence: { level: "media", reco: "review", label: "Media — elasticidad del depto.", color: "var(--db-warn)" },
      description: `Elasticidad común de ${p.category}: ${seg.n} SKUs, ${seg.obs} meses-SKU, con efectos fijos de SKU y mes (error ±${seg.se}, t=${seg.t}).`,
    });
  }
  return { results, best: results[0] || null, segment };
}

// Nota didáctica para la recomendación de precio
function priceChangeNote(pctChange, elasticity, currentPrice, marginPct, competitorMinPrice) {
  const absE = Math.abs(elasticity || 0);
  let base = "";
  if (pctChange > 0.5) {
    base = `Se sugiere SUBIR el precio ${pctChange.toFixed(1)}% porque la demanda es ${absE < 1 ? "inelástica" : "estable"}: el impacto en volumen es menor al aumento de ingreso por unidad.`;
  } else if (pctChange < -0.5) {
    base = `Se sugiere BAJAR el precio ${Math.abs(pctChange).toFixed(1)}% porque la demanda es elástica (|E|=${absE.toFixed(2)}): la reducción atrae más volumen del que pierdes en ingreso unitario.`;
  } else {
    base = `Se sugiere MANTENER el precio: el óptimo teórico coincide con el actual (±0.5%). Cualquier ajuste produce cambio marginal en ingreso.`;
  }
  if (competitorMinPrice && currentPrice) {
    const diff = ((currentPrice - competitorMinPrice) / competitorMinPrice) * 100;
    if (diff > 5) base += ` Tu precio está ${diff.toFixed(1)}% arriba del competidor más barato ($${competitorMinPrice}).`;
    else if (diff < -5) base += ` Tu precio está ${Math.abs(diff).toFixed(1)}% abajo del competidor más barato ($${competitorMinPrice}): posible oportunidad de subir.`;
  }
  if (marginPct > 0 && marginPct < 0.1) base += ` Margen bajo (${(marginPct * 100).toFixed(1)}%): cualquier baja de precio debe validarse contra el costo.`;
  return base;
}

// Nivel de confianza del modelo según MAPE y otros indicadores.
// Devuelve: { level: "alta"|"media"|"baja"|"muy_baja", reco: "auto_approve"|"review"|"reject", label, color }
function confidenceFromMape(mape, elasticity) {
  if (mape === null || mape === undefined || !isFinite(mape)) {
    return { level: "muy_baja", reco: "reject", label: "Sin datos — revisar", color: "var(--db-neg)" };
  }
  // Elasticidad positiva o exactamente 0 = sin señal
  if (elasticity === null || elasticity === undefined || elasticity >= 0) {
    return { level: "baja", reco: "reject", label: "Sin señal — mantener", color: "var(--db-neg)" };
  }
  if (mape < 20) return { level: "alta", reco: "auto_approve", label: "Alta — auto aprobar", color: "var(--db-pos)" };
  if (mape < 40) return { level: "media", reco: "auto_approve", label: "Media — auto aprobar", color: "var(--db-pos)" };
  if (mape < 60) return { level: "baja", reco: "review", label: "Baja — revisar", color: "var(--db-warn)" };
  return { level: "muy_baja", reco: "reject", label: "Muy baja — no aplicar", color: "var(--db-neg)" };
}

// Predicción de unidades usando elasticidad (constant-elasticity): Q_new = Q_old * (P_new/P_old)^E.
// Se usa la elasticidad saneada para evitar que outliers (|E|>4 o positivas) generen proyecciones explosivas.
function predictUnits(currentUnits, currentPrice, newPrice, elasticity) {
  if (!currentUnits || !currentPrice || !newPrice || !isFinite(elasticity)) return currentUnits || 0;
  const eSafe = sanitizeElasticity(elasticity);
  if (eSafe === 0 || Math.abs(newPrice - currentPrice) < 1e-6) return currentUnits;
  const ratio = newPrice / currentPrice;
  const pred = currentUnits * Math.pow(ratio, eSafe);
  if (!isFinite(pred) || pred < 0) return currentUnits;
  // Nunca dejamos que el modelo multiplique/divida la demanda por más de 5× en ±30%
  return Math.max(currentUnits * 0.2, Math.min(currentUnits * 5, pred));
}

// Nuevo margen después de ajustar el precio, asumiendo costo fijo = precio_actual × (1 − margen_actual)
function newMarginAfter(currentPrice, currentMargin, newPrice) {
  if (!currentPrice || !newPrice || currentMargin <= 0 || currentMargin >= 1) return null;
  const cost = currentPrice * (1 - currentMargin);
  if (newPrice <= 0) return null;
  return (newPrice - cost) / newPrice;
}

// Aplica redondeo de precio psicológico
function applyRounding(price, mode) {
  if (!isFinite(price) || price <= 0) return price;
  switch (mode) {
    case "integer": return Math.round(price);
    case "ending_99": return Math.floor(price) + 0.99;
    case "ending_95": return Math.floor(price) + 0.95;
    case "nearest_5": return Math.round(price / 5) * 5;
    default: return Math.round(price * 100) / 100;
  }
}

// Aplica las reglas de negocio a un precio sugerido.
// Devuelve { finalPrice, violations: [] } con las reglas que tuvieron que activarse.
function applyBusinessRules(suggested, currentPrice, currentMargin, compMinPrice, rules) {
  let p = suggested;
  const violations = [];

  // 1) Límite de cambio % (cap bidireccional)
  if (isFinite(rules.maxPctChange) && rules.maxPctChange > 0 && currentPrice > 0) {
    const maxUp = currentPrice * (1 + rules.maxPctChange / 100);
    const maxDown = currentPrice * (1 - rules.maxPctChange / 100);
    if (p > maxUp) { p = maxUp; violations.push(`Capado a +${rules.maxPctChange}% del actual`); }
    if (p < maxDown) { p = maxDown; violations.push(`Capado a -${rules.maxPctChange}% del actual`); }
  }

  // 2) Techo/piso absoluto
  if (isFinite(rules.maxPriceCeiling) && rules.maxPriceCeiling > 0 && p > rules.maxPriceCeiling) {
    p = rules.maxPriceCeiling;
    violations.push(`Techo de $${rules.maxPriceCeiling}`);
  }
  if (isFinite(rules.minPriceFloor) && rules.minPriceFloor > 0 && p < rules.minPriceFloor) {
    p = rules.minPriceFloor;
    violations.push(`Piso de $${rules.minPriceFloor}`);
  }

  // 3) Margen mínimo (sube precio si el margen resultante cae debajo)
  if (isFinite(rules.minMarginPct) && rules.minMarginPct > 0 && currentPrice > 0 && currentMargin > 0 && currentMargin < 1) {
    const cost = currentPrice * (1 - currentMargin);
    const minP = cost / (1 - rules.minMarginPct / 100);
    if (p < minP) { p = minP; violations.push(`Margen mínimo ${rules.minMarginPct}%`); }
  }

  // 4) Margen máximo (baja precio si el margen resultante sube demasiado)
  if (isFinite(rules.maxMarginPct) && rules.maxMarginPct > 0 && currentPrice > 0 && currentMargin > 0 && currentMargin < 1) {
    const cost = currentPrice * (1 - currentMargin);
    const maxP = cost / (1 - rules.maxMarginPct / 100);
    if (p > maxP) { p = maxP; violations.push(`Margen máximo ${rules.maxMarginPct}%`); }
  }

  // 5) Respetar competencia: sugerido ≤ compMin × (1 + X/100)
  if (isFinite(rules.priceAboveCompMin) && compMinPrice > 0) {
    const cap = compMinPrice * (1 + rules.priceAboveCompMin / 100);
    if (p > cap) { p = cap; violations.push(`Max ${rules.priceAboveCompMin}% sobre competencia mínima`); }
  }

  // 6) Redondeo
  p = applyRounding(p, rules.roundingMode || "none");

  return { finalPrice: Math.round(p * 100) / 100, violations };
}

// Util para ordenar filas con un sortConfig { key, dir }
function sortRows(rows, sortConfig) {
  if (!sortConfig || !sortConfig.key) return rows;
  const { key, dir } = sortConfig;
  const out = [...rows];
  out.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const aEmpty = av === null || av === undefined || av === "" || (typeof av === "number" && !isFinite(av));
    const bEmpty = bv === null || bv === undefined || bv === "" || (typeof bv === "number" && !isFinite(bv));
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
    return dir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });
  return out;
}

// K-means 1D/ND muy simple (determinístico: init con step uniforme)
function kmeans(points, k, iters = 25) {
  if (points.length === 0 || k <= 0) return [];
  if (points.length <= k) return points.map((_, i) => i);
  const dim = points[0].length;
  const step = Math.floor(points.length / k);
  const centroids = [];
  for (let i = 0; i < k; i++) centroids.push(points[Math.min(points.length - 1, i * step)].slice());
  const assignments = new Array(points.length).fill(0);
  for (let it = 0; it < iters; it++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        let d = 0;
        for (let f = 0; f < dim; f++) { const diff = points[i][f] - centroids[j][f]; d += diff * diff; }
        if (d < bd) { bd = d; best = j; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    if (!changed) break;
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < points.length; i++) {
      counts[assignments[i]]++;
      for (let f = 0; f < dim; f++) sums[assignments[i]][f] += points[i][f];
    }
    for (let j = 0; j < k; j++) if (counts[j] > 0) for (let f = 0; f < dim; f++) centroids[j][f] = sums[j][f] / counts[j];
  }
  return assignments;
}

// Sub-cluster para productos sin elasticidad utilizable (no entran al k-means)
const NO_SIGNAL_CLUSTER = "Sin señal de elasticidad";

// Clasificación ABC(D) por Pareto acumulado de revenue
function abcClassify(rows) {
  const sorted = [...rows].sort((a, b) => b.revenue - a.revenue);
  const total = sorted.reduce((s, r) => s + (r.revenue || 0), 0);
  let cum = 0;
  const mapping = {};
  for (const r of sorted) {
    cum += r.revenue || 0;
    const pct = total > 0 ? cum / total : 1;
    if (pct <= 0.70) mapping[r.sku] = "A";
    else if (pct <= 0.90) mapping[r.sku] = "B";
    else if (pct <= 0.98) mapping[r.sku] = "C";
    else mapping[r.sku] = "D";
  }
  return mapping;
}

/* ── Reusable Components ── */
// KPI con el material de .lp-heroc / .lp-minic (Pricing L'Oréal); accent = destacado en cian
function StatCard({ label, value, sub, accent }) {
  return (
    <div className={`el-kpi${accent ? " acc" : ""}`} style={{ flex: 1, minWidth: 120 }}>
      <small>{label}</small>
      <b>{value}</b>
      {sub && <em>{sub}</em>}
    </div>
  );
}

// KPI que gira al hacer clic (patrón .lp-flip de Pricing L'Oréal): frente = cifra principal, reverso = desglose.
// back: [{ k, v, tone? }] con tone = "pos" | "neg" | "warn"; tone de la tarjeta = "acc" | "pos" | "neg" | "warn"
function FlipCard({ label, value, sub, tone, back, backTitle }) {
  const [on, setOn] = useState(false);
  const flip = () => setOn(v => !v);
  return (
    <div className={`lp-flip el-flip${on ? " on" : ""}`} role="button" tabIndex={0} aria-pressed={on}
      title={on ? "Clic para volver a la cifra" : "Clic para ver el desglose"}
      onClick={flip} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } }}>
      <div className="lp-flip-in">
        <div className={`el-kpi lp-flip-f${tone ? ` ${tone}` : ""}`} aria-hidden={on}>
          <small>{label}</small>
          <b>{value}</b>
          {sub && <em>{sub}</em>}
          <span className="lp-flip-hint" aria-hidden="true">↻</span>
        </div>
        <div className={`el-kpi lp-flip-b${tone ? ` ${tone}` : ""}`} aria-hidden={!on}>
          <small>{backTitle || label}</small>
          <ul className="lp-back-l">
            {back.map(r => <li key={r.k}><span>{r.k}</span><strong className={r.tone ? `el-t-${r.tone}` : undefined}>{r.v}</strong></li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}

// Encabezado de sección: raya de acento + título Oswald (como .lp-eyebrow / .lp-card h3)
function SectionHead({ children }) {
  return <div className="el-sec"><h3>{children}</h3></div>;
}

function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="el-tip">
      <div className="el-tip-t">{label}</div>
      {payload.map((e, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: e.color, display: "inline-block" }} />
          <span style={{ color: C.sub }}>{e.name}:</span>
          <span style={{ fontWeight: 600 }}>
            {typeof e.value === "number" ? e.value.toLocaleString("es-MX", { maximumFractionDigits: 2 }) : e.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// Tooltips de Performance: dinero sin decimales, % con signo, y burbuja con sus tres medidas
function MoneyTip({ active, payload, label, signed }) {
  if (!active || !payload?.length) return null;
  const e = payload[0];
  return <div className="el-tip"><div className="el-tip-t">{label ?? e.payload.name}</div>{fmtMoney(e.value, signed)}</div>;
}

// Etiqueta al final de una barra horizontal: a la derecha si es positiva, a la izquierda si es negativa
const barEndLabel = (fmt) => function BarEndLabel({ x, y, width, height, value }) {
  const neg = value < 0;
  const left = Math.min(x, x + width), right = Math.max(x, x + width);
  return (
    <text x={neg ? left - 6 : right + 6} y={y + height / 2} dy="0.35em" textAnchor={neg ? "end" : "start"}
      style={{ fontSize: 11, fill: "var(--db-ink-2)", fontVariantNumeric: "tabular-nums" }}>
      {fmt(value)}
    </text>
  );
};

function WaterfallTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const w = payload[0].payload;
  return (
    <div className="el-tip">
      <div className="el-tip-t">{w.full ? `${w.name} · ${w.full}` : w.name}</div>
      {w.total ? <>Venta: <b>{fmtMoney(w.v)}</b></> : <>{w.v >= 0 ? "Sumó" : "Restó"}: <b className={`el-t-${w.v >= 0 ? "pos" : "neg"}`}>{fmtMoney(w.v, true)}</b></>}
    </div>
  );
}

function GroupTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const g = payload[0].payload;
  return (
    <div className="el-tip">
      <div className="el-tip-t">{g.name}</div>
      <div>Crecimiento: <b>{fmtPct(g.deltaPct, 1, true)}</b></div>
      <div>Venta: {fmtMoney(g.r1)} · antes {fmtMoney(g.r0)}</div>
    </div>
  );
}

function BubbleTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  return (
    <div className="el-tip">
      <div className="el-tip-t">{b.name}</div>
      <div>Δ precio: <b>{fmtPct(b.x, 1, true)}</b> · Δ unidades: <b>{fmtPct(b.y, 1, true)}</b></div>
      <div>Venta: {fmtMoney(b.z)} ({fmtPct(b.deltaPct, 1, true)}) · {fmtInt(b.n)} SKUs</div>
    </div>
  );
}

function Badge({ color, children }) {
  return (
    <span className={`el-badge ${["green", "red", "blue"].includes(color) ? color : "amber"}`}>
      {children}
    </span>
  );
}

/**
 * Encabezado de columna ordenable y re-dimensionable.
 * widthKey opcional: activa el handle de resize y toma/guarda width de widths[widthKey].
 */
function SortHeader({ label, sortKey, sortConfig, setSortConfig, align = "center", widthKey, widths, setWidths }) {
  const isActive = !!sortKey && !!sortConfig && sortConfig.key === sortKey;
  const arrow = isActive ? (sortConfig.dir === "asc" ? "▲" : "▼") : "⇅";
  const w = widthKey && widths ? widths[widthKey] : undefined;

  const startResize = (e) => {
    if (!widthKey || !setWidths) return;
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.parentElement;
    const startX = e.clientX;
    const startW = th.offsetWidth;
    const onMove = (mv) => setWidths(cw => ({ ...cw, [widthKey]: Math.max(50, startW + (mv.clientX - startX)) }));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleClick = () => {
    if (!sortKey || typeof setSortConfig !== "function") return;
    setSortConfig(s => {
      const prev = s || {};
      return {
        key: sortKey,
        dir: prev.key === sortKey && prev.dir === "asc" ? "desc" : "asc",
      };
    });
  };

  return (
    <th
      onClick={handleClick}
      style={{
        padding: "10px 8px", textAlign: align, color: C.sub, fontWeight: 600,
        fontSize: 9.5, lineHeight: 1.3, textTransform: "uppercase", whiteSpace: "normal", verticalAlign: "bottom",
        cursor: sortKey ? "pointer" : "default", userSelect: "none",
        width: w, minWidth: 50, position: "relative", overflowWrap: "normal",
      }}
    >
      {/* El título puede partirse en dos renglones; la flecha de orden siempre va pegada a la última palabra */}
      {label}{sortKey && <span style={{ opacity: isActive ? 1 : 0.3, marginLeft: 3, whiteSpace: "nowrap" }}>{arrow}</span>}
      {widthKey && typeof setWidths === "function" && (
        <span
          onMouseDown={startResize}
          onClick={(e) => e.stopPropagation()}
          style={{ position: "absolute", top: 0, right: 0, width: 6, height: "100%", cursor: "col-resize" }}
        />
      )}
    </th>
  );
}

function MethodBadge({ method }) {
  const fg = METHOD_COLORS[method] || C.sub;
  const bg = `color-mix(in srgb, ${fg} 14%, transparent)`;
  const label = method === "ols" ? "OLS Lineal" : method === "loglog" ? "Log-Log" : method === "segment" ? "Panel depto." : method === "sku_fe" ? "SKU s/estacionalidad" : "Arco Mid-Point";
  return <span style={{ background: bg, color: fg, padding: "3px 10px", borderRadius: 16, fontSize: 10, fontWeight: 600 }}>{label}</span>;
}

class ErrBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.log("ErrBoundary caught:", err, info); }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 20, background: "var(--db-neg-soft)", border: "2px solid var(--db-neg)", borderRadius: 10, color: "var(--db-neg)", fontFamily: "monospace", fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Error en {this.props.name || "componente"}:</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{String(this.state.err?.stack || this.state.err)}</div>
          <button onClick={() => this.setState({ err: null })} className="el-btn" style={{ marginTop: 10, padding: "6px 12px", cursor: "pointer" }}>Reintentar</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Spinner({ msg }) {
  return (
    <div className="sp-msg" aria-busy="true"><span className="sp-spin" />{msg || "Cargando datos…"}</div>
  );
}

/* ── MAIN APP ── */
export default function App() {
  const [data, setData] = useState(null);
  const [competitor, setCompetitor] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadMsg, setLoadMsg] = useState(null); // aviso mientras la API genera los datos desde S3
  const [loadError, setLoadError] = useState(null);
  const [tab, setTab] = useState("performance");
  const [adminSection, setAdminSection] = useState("scenario"); // sub-sección dentro del tab "Configuración": scenario | rules | families | audit
  const [perfWindow, setPerfWindow] = useState("q"); // Performance: m | q | s | yoy (ver perfWindows)
  const [perfDim, setPerfDim] = useState("category"); // Performance: agrupación del mapa de burbujas (brand | category | department)
  const [perfFocus, setPerfFocus] = useState(null); // Performance: grupo elegido en el mapa, filtra las tablas
  const [perfBridge, setPerfBridge] = useState("pv"); // Performance: cascada por precio/volumen ("pv") o por departamento ("group")
  const [detailSku, setDetailSku] = useState(null); // SKU cuyo popup de análisis de elasticidad está abierto
  const [searchTerm, setSearchTerm] = useState("");
  const [filterDept, setFilterDept] = useState("all");
  const [filterCat, setFilterCat] = useState("all");
  const [filterClass, setFilterClass] = useState("all");
  const [page, setPage] = useState(0);
  const [approvals, setApprovals] = useState({}); // { sku: 'approved'|'rejected' }
  const [overrides, setOverrides] = useState({}); // { sku: manualSuggestedPrice }
  const [uploadError, setUploadError] = useState("");
  const [uploadInfo, setUploadInfo] = useState(null); // { matched, notFound, total }
  const [portfolioSort, setPortfolioSort] = useState({ key: null, dir: "asc" });
  // Ancho inicial por columna del Portafolio (px); el usuario los ajusta arrastrando el borde del encabezado
  const [portfolioWidths, setPortfolioWidths] = useState({
    img: 48, sku: 84, upc: 112, prod: 230, cat: 120, abc: 58, sub: 136, pa: 92, marg: 72, elas: 84, met: 128, conf: 100,
    ps: 108, ch: 80, nm: 82, cm: 84, ua: 82, up: 94, va: 104, vp: 112, pf: 98, dec: 88,
  });
  const [subSort, setSubSort] = useState({ key: "revenue", dir: "desc" });
  const [auditLog, setAuditLog] = useState([]); // [{ ts, user, action, sku, family, detail, before, after }]
  const [currentUser, setCurrentUser] = useState(() => {
    try { return localStorage.getItem("elasticity_user") || "Diego Sosa"; } catch { return "Diego Sosa"; }
  });
  const { tema, sprint, cambiarTema } = useTemaAnimado();
  const [scenario, setScenario] = useState("balanced"); // balanced | aggressive | conservative | keep_margin | hold_price
  const [familyRules, setFamilyRules] = useState({}); // { sku: "Nombre de familia" }
  // Reglas de negocio específicas por familia (sobreescriben las globales cuando se activan)
  // { familyName: { maxPctChange, minMarginPct, maxMarginPct, minPriceFloor, maxPriceCeiling, priceAboveCompMin, roundingMode } }
  const [familyBusinessRules, setFamilyBusinessRules] = useState({});
  // Precio fijo por familia { familyName: price }: lo define el usuario y se aplica igual a todos los SKUs de la
  // familia, como un override manual (no pasa por reglas). Sin precio fijo, la familia usa el sugerido por elasticidad.
  const [familyPrices, setFamilyPrices] = useState({});
  // Reglas por categoría { category: { maxPctChange, ... } }: solo las llaves definidas sobreescriben a las globales.
  // Precedencia: familia > categoría > escenario > global
  const [categoryRules, setCategoryRules] = useState({});
  const [ruleScope, setRuleScope] = useState("global"); // "global" o el nombre de la categoría que se está editando
  const [familyUploadMsg, setFamilyUploadMsg] = useState("");
  const [clusterPopup, setClusterPopup] = useState(null); // { key, abc, sub, products: [...] }
  const [ruleBuilderOpen, setRuleBuilderOpen] = useState(false);
  const [businessRules, setBusinessRules] = useState({
    maxPctChange: 30,        // % máximo que puede cambiar el precio vs actual (±)
    minMarginPct: null,      // Margen mínimo (% sobre precio, p.ej. 10 significa 10%)
    maxMarginPct: null,      // Margen máximo permitido
    minPriceFloor: null,     // Precio piso absoluto en $
    maxPriceCeiling: null,   // Precio techo absoluto en $
    priceAboveCompMin: null, // Cuánto % mínimo el sugerido debe estar sobre/bajo el min de competencia
    roundingMode: "none",    // "none" | "integer" | "ending_99" | "ending_95" | "nearest_5"
    lowConfidence: "hold",   // "hold" = mantener precio actual si el modelo no es confiable | "suggest" = sugerir de todos modos
  });
  const PAGE_SIZE = 20;

  useEffect(() => {
    let vivo = true;
    let espera = null;
    const cargar = async () => {
      try {
        const r = await fetch(`${DATA_BASE}data.json`);
        if (r.status === 503) { // la API está bajando los datos de S3: se reintenta solo
          const b = await r.json().catch(() => ({}));
          if (vivo) { setLoadMsg(b.detail || "Generando los datos desde S3…"); espera = setTimeout(cargar, REINTENTO_MS); }
          return;
        }
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        const d = await r.json();
        const comp = await fetch(`${DATA_BASE}competitor.json`).then(x => x.ok ? x.json() : {}).catch(() => ({}));
        if (!vivo) return;
        setData(d);
        setCompetitor(comp || {});
        setLoading(false);
      } catch (err) {
        console.error(err);
        if (vivo) { setLoadError(CLIENT ? `No se pudo conectar con la API de datos (${err.message}). ¿Está corriendo backend/ (npm start)?` : null); setLoading(false); }
      }
    };
    cargar();
    return () => { vivo = false; clearTimeout(espera); };
  }, []);

  // Lookup de competencia por SKU (via UPC normalizado)
  const compBySku = useMemo(() => {
    if (!data) return {};
    const out = {};
    for (const p of data.products) {
      const nu = normUpc(p.upc);
      if (nu && competitor[nu]) out[p.sku] = competitor[nu];
    }
    return out;
  }, [data, competitor]);

  // Reglas efectivas = escenario sobre globales
  const effectiveGlobalRules = useMemo(() => {
    const sc = SCENARIOS[scenario];
    if (!sc || !sc.rules) return businessRules;
    return { ...businessRules, ...sc.rules };
  }, [scenario, businessRules]);

  // Familias agregadas: { familyName: { series: [...] (combinada mes a mes), skus: [...] } }
  const familyAggregates = useMemo(() => {
    if (!data) return {};
    const byFamily = {};
    for (const p of data.products) {
      const fam = familyRules[p.sku];
      if (!fam) continue;
      if (!byFamily[fam]) byFamily[fam] = { skus: [], monthMap: {} };
      byFamily[fam].skus.push(p.sku);
      for (const s of p.series) {
        if (!byFamily[fam].monthMap[s.month]) byFamily[fam].monthMap[s.month] = { units: 0, priceWeight: 0, priceSum: 0, marginWeight: 0, marginSum: 0 };
        const rec = byFamily[fam].monthMap[s.month];
        rec.units += s.units;
        if (s.price > 0 && s.units > 0) { rec.priceSum += s.price * s.units; rec.priceWeight += s.units; }
        if (s.margin > 0 && s.units > 0) { rec.marginSum += s.margin * s.units; rec.marginWeight += s.units; }
      }
    }
    const out = {};
    for (const fam of Object.keys(byFamily)) {
      const months = Object.keys(byFamily[fam].monthMap).sort();
      const series = months.map(m => {
        const r = byFamily[fam].monthMap[m];
        return {
          month: m,
          units: r.units,
          price: r.priceWeight > 0 ? r.priceSum / r.priceWeight : 0,
          margin: r.marginWeight > 0 ? r.marginSum / r.marginWeight : 0,
        };
      });
      out[fam] = { skus: byFamily[fam].skus, series };
    }
    return out;
  }, [data, familyRules]);

  const allAnalysis = useMemo(() => {
    if (!data) return {};
    const map = {};
    // Pre-calculo análisis a nivel familia
    const familyAnalysis = {};
    for (const fam of Object.keys(familyAggregates)) {
      familyAnalysis[fam] = analyzeElasticity(familyAggregates[fam].series);
    }
    for (const p of data.products) {
      const fam = familyRules[p.sku];
      if (data.segmentElasticity) {
        // Elasticidad pre-calculada: cada SKU conserva la suya. En familias, familySuggest toma
        // la del primer SKU para fijar el precio único.
        const pre = precomputedAnalysis(p, data.segmentElasticity);
        map[p.sku] = fam ? { ...pre, familyName: fam } : pre;
      } else if (fam && familyAnalysis[fam]) {
        // El SKU hereda el análisis de su familia
        map[p.sku] = { ...familyAnalysis[fam], familyName: fam };
      } else {
        map[p.sku] = analyzeElasticity(p.series);
      }
    }
    return map;
  }, [data, familyRules, familyAggregates]);

  // Pre-calculo del PRECIO FINAL sugerido a nivel familia:
  // La familia recibe un único precio sugerido calculado sobre su precio agregado,
  // y ese MISMO PRECIO se aplica a todos los SKUs de la familia (no el mismo %).
  // Esto es porque en la tienda todos los sabores deben costar lo mismo.
  const familySuggest = useMemo(() => {
    if (!data) return {};
    const out = {};
    for (const fam of Object.keys(familyAggregates)) {
      const agg = familyAggregates[fam];
      const analysis = allAnalysis[agg.skus[0]]; // mismo análisis para todos los SKUs de la familia
      const best = analysis?.best;
      if (!best) continue;
      const lastMonth = agg.series[agg.series.length - 1];
      if (!lastMonth) continue;
      const sug = suggestPrice(lastMonth.price, best.elasticity, lastMonth.margin);
      out[fam] = {
        finalPrice: sug.suggestedPrice,
        familyBasePrice: lastMonth.price,
        reason: sug.reason,
      };
    }
    return out;
  }, [data, familyAggregates, allAnalysis]);

  const departments = useMemo(() => data ? [...new Set(data.products.map(p => p.department).filter(Boolean))].sort() : [], [data]);
  // Filtros encadenados: cada lista solo ofrece valores que existen con los filtros de arriba,
  // para no poder armar combinaciones vacías (ej. TECNOLOGIA + CORSETERIA).
  const matchesFilters = useCallback((p, dept, cat, cls) =>
    (dept === "all" || p.department === dept) &&
    (cat === "all" || p.category === cat) &&
    (cls === "all" || p.fesa_classification === cls), []);
  const categories = useMemo(() => data ? [...new Set(data.products.filter(p => matchesFilters(p, filterDept, "all", "all")).map(p => p.category).filter(Boolean))].sort() : [], [data, filterDept, matchesFilters]);
  const classifications = useMemo(() => data ? [...new Set(data.products.filter(p => matchesFilters(p, filterDept, filterCat, "all")).map(p => p.fesa_classification).filter(Boolean))].sort() : [], [data, filterDept, filterCat, matchesFilters]);
  // Si el dataset nombra su clasificación (Bodesa: "Cadena" = El Bodegón / La Marina), se vuelve selector principal
  const allCategories = useMemo(() => data ? [...new Set(data.products.map(p => p.category).filter(Boolean))].sort() : [], [data]);
  const chainLabel = data?.classificationLabel || null;
  const chains = useMemo(() => chainLabel ? [...new Set(data.products.map(p => p.fesa_classification).filter(Boolean))].sort() : [], [data, chainLabel]);
  const changeChain = (cls) => {
    setFilterClass(cls);
    if (cls !== "all") { // con una sola cadena, agrupar por cadena ya no explica nada
      setPerfDim(d => (d === "chain" ? "category" : d));
      setPerfBridge(b => (b === "chain" ? "pv" : b));
      setPerfFocus(null);
    }
    if (cls !== "all" && !data.products.some(p => matchesFilters(p, filterDept, filterCat, cls))) { setFilterDept("all"); setFilterCat("all"); }
  };

  // Al cambiar un filtro de arriba, los de abajo vuelven a "todos" si ya no tienen productos
  const changeDept = (dept) => {
    const cat = data.products.some(p => matchesFilters(p, dept, filterCat, "all")) ? filterCat : "all";
    setFilterDept(dept);
    setFilterCat(cat);
    if (!data.products.some(p => matchesFilters(p, dept, cat, filterClass))) setFilterClass("all");
  };
  const changeCat = (cat) => {
    setFilterCat(cat);
    if (!data.products.some(p => matchesFilters(p, filterDept, cat, filterClass))) setFilterClass("all");
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.products.filter(p => {
      if (filterDept !== "all" && p.department !== filterDept) return false;
      if (filterCat !== "all" && p.category !== filterCat) return false;
      if (filterClass !== "all" && p.fesa_classification !== filterClass) return false;
      if (searchTerm) {
        const s = searchTerm.toLowerCase();
        const upcQuery = normUpc(searchTerm); // EAN/UPC sin ceros a la izquierda, igual que el cruce con competencia
        return (p.sku_des || "").toLowerCase().includes(s) || p.sku.toString().includes(s) || (p.brand || "").toLowerCase().includes(s)
          || (upcQuery.length >= 4 && normUpc(p.upc).includes(upcQuery));
      }
      return true;
    });
  }, [data, filterDept, filterCat, filterClass, searchTerm]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  useEffect(() => setPage(0), [filterDept, filterCat, filterClass, searchTerm]);

  const portfolioData = useMemo(() => {
    if (!data) return [];
    return filtered.map(p => {
      const analysis = allAnalysis[p.sku];
      const best = analysis?.best;
      const lastMonth = p.series[p.series.length - 1];
      const currentPrice = lastMonth?.price || p.avgPrice;
      const currentMargin = lastMonth?.margin || 0;
      const fam = familyRules[p.sku];
      // Si pertenece a una familia, TODOS los SKUs reciben el MISMO precio final sugerido.
      let sug;
      if (fam && familySuggest[fam]) {
        const famSug = familySuggest[fam];
        const sp = famSug.finalPrice;
        const pct = currentPrice > 0 ? ((sp - currentPrice) / currentPrice) * 100 : 0;
        sug = {
          suggestedPrice: sp,
          pctChange: Math.round(pct * 100) / 100,
          reason: famSug.reason + " · Precio único de familia \"" + fam + "\"",
        };
      } else {
        sug = best ? suggestPrice(currentPrice, best.elasticity, currentMargin) : null;
      }
      const autoSuggestedRaw = sug?.suggestedPrice ?? currentPrice;
      // El override manual del SKU gana; si no hay, el precio fijo de su familia
      const famPrice = fam ? familyPrices[fam] : undefined;
      const usesFamPrice = !isFinite(overrides[p.sku]) && isFinite(famPrice);
      const override = usesFamPrice ? famPrice : overrides[p.sku];
      const compMin = compBySku[p.sku]?.minPrice;
      // Reglas efectivas: familia > categoría > escenario > globales
      const effectiveRules = {
        ...effectiveGlobalRules,
        ...(categoryRules[p.category] || {}),
        ...(fam && familyBusinessRules[fam] ? familyBusinessRules[fam] : {}),
      };
      const ruled = applyBusinessRules(autoSuggestedRaw, currentPrice, currentMargin, compMin, effectiveRules);
      const confidence = best?.confidence || confidenceFromMape(best?.mape, best?.elasticity);
      // Modelo no confiable (MAPE > 60% o sin señal): por defecto se mantiene el precio actual en lugar de
      // sugerir un cambio que la propia herramienta marca como "no aplicar" (configurable en Reglas de negocio)
      const holdLowConf = effectiveRules.lowConfidence !== "suggest" && confidence.reco === "reject";
      const autoSuggested = holdLowConf ? currentPrice : ruled.finalPrice;
      const finalSuggested = isFinite(override) ? override : autoSuggested;
      const pctChange = currentPrice > 0 ? ((finalSuggested - currentPrice) / currentPrice) * 100 : 0;
      const elast = best?.elasticity ?? 0;
      const lastUnits = lastMonth?.units || 0;
      const predUnits = predictUnits(lastUnits, currentPrice, finalSuggested, elast);
      const newMargin = newMarginAfter(currentPrice, currentMargin, finalSuggested);
      const currentRevenue = currentPrice * lastUnits;
      const suggestedRevenue = finalSuggested * predUnits;
      return {
        ...p,
        currentPrice,
        currentMargin,
        lastUnits,
        elasticity: best?.elasticity ?? null,
        methodId: best?.id ?? null,
        methodName: best?.method ?? "N/A",
        mape: best?.mape ?? null,
        r2: best?.r2 ?? null,
        suggestedPrice: finalSuggested,
        autoSuggestedPrice: autoSuggested,
        isOverridden: isFinite(override),
        pctChange: Math.round(pctChange * 100) / 100,
        reason: usesFamPrice ? `Precio fijo de familia "${fam}"`
          : holdLowConf && !isFinite(override) ? "Modelo poco confiable: se mantiene el precio actual"
          : (sug?.reason ?? ""),
        predUnits: Math.round(predUnits),
        newMargin,
        currentRevenue,
        suggestedRevenue,
        family: familyRules[p.sku] || null,
        confidence: confidence.level,
        confidenceLabel: confidence.label,
        confidenceColor: confidence.color,
        recommendation: confidence.reco,
        ruleViolations: ruled.violations,
        // Precio final que se aplicaría: si aprobado usa sugerido, si no usa actual
        priceFinal: approvals[p.sku] === "approved" ? finalSuggested : currentPrice,
        decisionState: approvals[p.sku] || "pending",
        // campos numéricos planos para el sort
        revenue: currentRevenue,
      };
    });
  }, [data, filtered, allAnalysis, overrides, familyRules, familySuggest, familyPrices, compBySku, effectiveGlobalRules, categoryRules, familyBusinessRules, approvals]);

  const downloadPortfolioCSV = useCallback(() => {
    const rows = [["SKU", "UPC", "Descripcion", "Departamento", "Categoria", "Clasificacion", "Brand", "Precio Actual", "Margen Actual %", "Elasticidad", "Metodo", "MAPE%", "Precio Sugerido", "Precio Override Manual", "Cambio%", "Nuevo Margen %", "Unidades Ultimo Mes", "Unidades Proyectadas", "Venta Actual", "Venta Proyectada", "Decision", "Razon"]];
    portfolioData.forEach(r => {
      rows.push([
        r.sku, r.upc || "", r.sku_des, r.department, r.category, r.fesa_classification, r.brand,
        r.currentPrice, (r.currentMargin * 100).toFixed(2), r.elasticity, r.methodName, r.mape,
        r.suggestedPrice, r.isOverridden ? "SI" : "NO", r.pctChange,
        r.newMargin !== null ? (r.newMargin * 100).toFixed(2) : "",
        r.lastUnits, r.predUnits, Math.round(r.currentRevenue), Math.round(r.suggestedRevenue),
        approvals[r.sku] || "pendiente", r.reason,
      ]);
    });
    const csv = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "portfolio_precios_sugeridos.csv"; a.click();
    URL.revokeObjectURL(url);
  }, [portfolioData, approvals]);

  // Cálculo global de clusters (tab Clusters + columna del Portafolio).
  // El ABC va sobre TODO el portafolio filtrado; los productos sin elasticidad utilizable
  // (sin análisis, positiva o cero) forman su propio sub-cluster en vez de entrar al k-means,
  // donde quedarían etiquetados como "inelásticos" y candidatos a subir precio.
  const clusterInfo = useMemo(() => {
    if (!data || !portfolioData.length) return { map: {}, groups: { A: [], B: [], C: [], D: [] }, rows: [] };
    const rows = portfolioData.map(p => {
      const units = p.series.map(s => s.units);
      const prices = p.series.map(s => s.price).filter(x => x > 0);
      const meanU = units.reduce((a, b) => a + b, 0) / Math.max(units.length, 1);
      const varU = units.reduce((a, b) => a + (b - meanU) ** 2, 0) / Math.max(units.length, 1);
      const cv = meanU > 0 ? Math.sqrt(varU) / meanU : 0;
      const priceRange = prices.length ? (Math.max(...prices) - Math.min(...prices)) / Math.max(...prices) : 0;
      return {
        sku: p.sku,
        sku_des: p.sku_des || p.sku,
        category: p.category,
        brand: p.brand,
        revenue: p.currentRevenue,
        elasticity: p.elasticity,
        elasticitySafe: p.elasticity === null ? 0 : sanitizeElasticity(p.elasticity),
        cv,
        priceRange,
        mape: p.mape,
        currentPrice: p.currentPrice,
        suggestedPrice: p.suggestedPrice,
        pctChange: p.pctChange,
      };
    });
    const abc = abcClassify(rows);
    rows.forEach(r => r.abc = abc[r.sku]);
    const groups = { A: [], B: [], C: [], D: [] };
    rows.forEach(r => groups[r.abc]?.push(r));
    const labelMap = {}; // sku -> "X-label"
    const productsByCluster = {}; // clusterKey -> [rows]
    const assignTo = (r, cls, sub) => {
      const key = `${cls}-${sub}`;
      labelMap[r.sku] = { abc: cls, sub, key };
      if (!productsByCluster[key]) productsByCluster[key] = [];
      productsByCluster[key].push(r);
    };
    for (const cls of Object.keys(groups)) {
      groups[cls].filter(r => r.elasticitySafe === 0).forEach(r => assignTo(r, cls, NO_SIGNAL_CLUSTER));
      const g = groups[cls].filter(r => r.elasticitySafe < 0);
      if (g.length === 0) continue;
      const feats = g.map(r => [
        Math.max(-4, Math.min(0, r.elasticitySafe)),
        Math.max(0, Math.min(3, r.cv)),
        Math.max(0, Math.min(1, r.priceRange)),
      ]);
      for (let c = 0; c < 3; c++) {
        const col = feats.map(f => f[c]);
        const mn = Math.min(...col), mx = Math.max(...col);
        const range = mx - mn || 1;
        feats.forEach(f => { f[c] = (f[c] - mn) / range; });
      }
      const k = Math.min(3, g.length);
      const assign = kmeans(feats, k);
      const stats = Array.from({ length: k }, () => ({ ids: [], elastSum: 0, cvSum: 0 }));
      g.forEach((r, i) => {
        const a = assign[i];
        stats[a].ids.push(r.sku);
        stats[a].elastSum += r.elasticitySafe;
        stats[a].cvSum += r.cv;
      });
      const labels = stats.map(s => {
        const avgE = s.elastSum / Math.max(s.ids.length, 1);
        const avgCv = s.cvSum / Math.max(s.ids.length, 1);
        if (Math.abs(avgE) >= 1.5) return "Elásticos (|E|≥1.5)";
        if (Math.abs(avgE) >= 0.7) return "Moderadamente elásticos";
        if (avgCv > 0.5) return "Estables / volátiles en volumen";
        return "Inelásticos estables";
      });
      g.forEach((r, i) => assignTo(r, cls, labels[assign[i]]));
    }
    return { map: labelMap, groups, productsByCluster, rows };
  }, [data, portfolioData]);

  // Performance de ventas: ventanas de comparación que permite el histórico (meses contiguos de data.months)
  const perfWindows = useMemo(() => {
    const months = data?.months || [];
    const n = months.length;
    const opts = [];
    if (n >= 2) opts.push({ v: "m", t: "Mes vs mes anterior", cur: months.slice(-1), prev: months.slice(-2, -1) });
    if (n >= 6) opts.push({ v: "q", t: "3 meses vs 3 anteriores", cur: months.slice(-3), prev: months.slice(-6, -3) });
    if (n >= 12) opts.push({ v: "s", t: "6 meses vs 6 anteriores", cur: months.slice(-6), prev: months.slice(-12, -6) });
    const yoyPrev = months.slice(-3).map(m => `${Number(m.slice(0, 4)) - 1}${m.slice(4)}`);
    if (n >= 3 && yoyPrev.every(m => months.includes(m))) opts.push({ v: "yoy", t: "Año contra año (3 meses)", cur: months.slice(-3), prev: yoyPrev });
    return opts;
  }, [data]);
  const perfWin = perfWindows.find(o => o.v === perfWindow) || perfWindows.find(o => o.v === "q") || perfWindows[0] || null;

  // Por SKU filtrado: venta (unidades × precio del mes, mismo criterio que currentRevenue) en ambas ventanas y el
  // puente sin término cruzado: (P1−P0)·Q1 [efecto precio] + P0·(Q1−Q0) [efecto volumen] = R1 − R0.
  const perf = useMemo(() => {
    if (!data || !perfWin) return null;
    const cur = new Set(perfWin.cur), prev = new Set(perfWin.prev);
    const byMonth = Object.fromEntries(data.months.map(m => [m, 0]));
    const rows = [];
    for (const p of filtered) {
      let r1 = 0, q1 = 0, r0 = 0, q0 = 0;
      for (const s of p.series) {
        const rev = s.units * s.price;
        if (s.month in byMonth) byMonth[s.month] += rev;
        if (cur.has(s.month)) { r1 += rev; q1 += s.units; } else if (prev.has(s.month)) { r0 += rev; q0 += s.units; }
      }
      if (r0 <= 0 && r1 <= 0) continue;
      const status = r0 <= 0 ? "new" : r1 <= 0 ? "lost" : "both";
      const p1 = q1 > 0 ? r1 / q1 : null, p0 = q0 > 0 ? r0 / q0 : null;
      const both = status === "both" && p1 !== null && p0 !== null;
      rows.push({
        sku: p.sku, sku_des: p.sku_des || p.sku, department: p.department, category: p.category, brand: p.brand, chain: p.fesa_classification,
        r1, r0, q1, q0, p1, p0, status,
        delta: r1 - r0,
        deltaPct: r0 > 0 ? ((r1 - r0) / r0) * 100 : null,
        pricePct: both ? ((p1 - p0) / p0) * 100 : null,
        unitsPct: both ? ((q1 - q0) / q0) * 100 : null,
        priceEff: both ? (p1 - p0) * q1 : 0,
        volEff: both ? p0 * (q1 - q0) : 0,
        quad: both ? `${p1 >= p0 ? "pu" : "pd"}${q1 >= q0 ? "vu" : "vd"}` : null,
      });
    }
    const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);
    const R1 = sum(rows, "r1"), R0 = sum(rows, "r0"), Q1 = sum(rows, "q1"), Q0 = sum(rows, "q0");
    const newRows = rows.filter(r => r.status === "new"), lostRows = rows.filter(r => r.status === "lost");
    const bridge = {
      price: sum(rows, "priceEff"), volume: sum(rows, "volEff"),
      added: sum(newRows, "r1"), lost: -sum(lostRows, "r0"),
    };
    // Concentración del periodo actual
    const ranked = rows.filter(r => r.r1 > 0).sort((a, b) => b.r1 - a.r1);
    let acc = 0, n80 = 0;
    for (const r of ranked) { if (acc >= 0.8 * R1) break; acc += r.r1; n80++; }
    const top10 = ranked.slice(0, 10).reduce((s, r) => s + r.r1, 0);
    // Por departamento, o por categoría si ya hay un departamento elegido
    const groupKey = filterDept === "all" ? "department" : "category";
    const groupsMap = {};
    for (const r of rows) {
      const g = r[groupKey] || "Sin clasificar";
      if (!groupsMap[g]) groupsMap[g] = { name: g, r1: 0, r0: 0 };
      groupsMap[g].r1 += r.r1; groupsMap[g].r0 += r.r0;
    }
    const groups = Object.values(groupsMap)
      .map(g => ({ ...g, delta: g.r1 - g.r0, deltaPct: g.r0 > 0 ? ((g.r1 - g.r0) / g.r0) * 100 : null }))
      .filter(g => g.deltaPct !== null)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12)
      .sort((a, b) => b.deltaPct - a.deltaPct);
    // Mapa precio-volumen: por grupo, Δ precio y Δ unidades medidos solo con SKUs que vendieron en ambos periodos
    // (los nuevos o sin venta moverían el promedio por mezcla, no por precio); tamaño = venta del periodo actual
    const bubbleMap = {};
    for (const r of rows) {
      const g = r[perfDim] || "Sin clasificar";
      if (!bubbleMap[g]) bubbleMap[g] = { name: g, r1: 0, r0: 0, br1: 0, bq1: 0, br0: 0, bq0: 0, n: 0 };
      const b = bubbleMap[g];
      b.r1 += r.r1; b.r0 += r.r0; b.n++;
      if (r.quad) { b.br1 += r.r1; b.bq1 += r.q1; b.br0 += r.r0; b.bq0 += r.q0; }
    }
    const bubbles = Object.values(bubbleMap)
      .filter(b => b.bq0 > 0 && b.bq1 > 0)
      .map(b => ({
        name: b.name, z: b.r1, n: b.n,
        x: ((b.br1 / b.bq1) / (b.br0 / b.bq0) - 1) * 100,
        y: (b.bq1 / b.bq0 - 1) * 100,
        deltaPct: b.r0 > 0 ? ((b.r1 - b.r0) / b.r0) * 100 : null,
      }))
      .sort((a, b) => b.z - a.z).slice(0, 30);
    const trend = data.months.map(m => ({ month: m, label: fmtMonth(m), venta: byMonth[m], zone: cur.has(m) ? "cur" : prev.has(m) ? "prev" : "" }));
    return {
      rows, R1, R0, Q1, Q0, bridge, trend, groups, groupKey, bubbles,
      growing: rows.filter(r => r.status === "both" && r.delta > 0).length,
      falling: rows.filter(r => r.status === "both" && r.delta < 0).length,
      added: newRows.length, lostN: lostRows.length,
      top10Share: R1 > 0 ? (top10 / R1) * 100 : 0, n80, nSelling: ranked.length,
    };
  }, [data, filtered, perfWin, filterDept, perfDim]);

  // Helper para registrar eventos en el log de auditoría
  const logAudit = useCallback((entry) => {
    setAuditLog(prev => [{
      ts: new Date().toISOString(),
      user: currentUser,
      ...entry,
    }, ...prev].slice(0, 5000));
  }, [currentUser]);

  // Handler para upload UPC + precio que llena los overrides del portafolio
  const handlePortfolioUpload = useCallback((file) => {
    if (!file || !data) return;
    setUploadError("");
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = String(ev.target.result).replace(/^\uFEFF/, "");
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) { setUploadError("Archivo vacío o sin datos"); return; }
        const header = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/"/g, ""));
        const upcIdx = header.findIndex(h => h === "upc");
        const priceIdx = header.findIndex(h => h === "price");
        if (upcIdx < 0 || priceIdx < 0) { setUploadError("El CSV debe tener columnas 'upc' y 'price'"); return; }
        const next = { ...overrides };
        let matched = 0, notFound = 0, invalid = 0;
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(",").map(x => x.trim().replace(/"/g, ""));
          const upcRaw = parts[upcIdx];
          const newPrice = parseFloat(parts[priceIdx]);
          if (!upcRaw || !isFinite(newPrice) || newPrice <= 0) { invalid++; continue; }
          const nu = normUpc(upcRaw);
          const prod = data.products.find(pp => normUpc(pp.upc) === nu);
          if (!prod) { notFound++; continue; }
          next[prod.sku] = newPrice;
          matched++;
        }
        setOverrides(next);
        setUploadInfo({ matched, notFound, invalid, total: matched + notFound + invalid });
      } catch (err) { setUploadError("Error leyendo archivo: " + err.message); }
    };
    reader.readAsText(file);
  }, [data, overrides]);

  // Marco visual de Pricing L'Oréal / Tiendas Bara: sección .sp con tema claro/oscuro y tarjetas glass
  const marco = (contenido) => (
    <div className="el-shell">
      <div className="sp lp ba db-ui" data-theme={tema} onPointerMove={brillo}>
        {sprint && <Sprint y={sprint.y} />}
        {contenido}
      </div>
    </div>
  );

  if (loading) return marco(<Spinner msg={loadMsg} />);
  if (!data) return marco(<div className="sp-msg" role="alert" style={{ color: C.red }}>{loadError || "Error cargando datos"}</div>);

  // Orden de la historia: qué está pasando → qué productos importan → qué precio poner; luego configuración y ayuda
  const tabs = [
    { id: "performance", label: "1 · Performance" },
    { id: "clusters", label: "2 · Segmentación" },
    { id: "portfolio", label: "3 · Sugerencia de precios" },
    { id: "admin", label: "Configuración" },
    { id: "glossary", label: "Glosario" },
  ];
  const opcionesFiltro = (todas, lista) => [{ v: "all", t: todas }, ...lista.map(x => ({ v: x, t: x }))];

  return marco(
    <>
      {/* HEADER */}
      <header className="sp-head">
        <div className="ba-marca">
          <span className="ba-logo" aria-hidden="true"><svg viewBox="0 0 24 24">{CURVA}</svg></span>
          <div>
            <span className="sp-eyebrow"><i />Pricing tool · Data Bunker</span>
            <h2>Price Elasticity <span>Engine</span></h2>
            <p>Análisis de Elasticidad de Precios{data.client ? <> · <b>{data.client}</b></> : ""}</p>
          </div>
        </div>
        <div className="sp-head-r">
          <span className="el-live"><i aria-hidden="true" /><b>{data.products.length.toLocaleString("es-MX")}</b> SKUs · En vivo</span>
          <TemaBoton tema={tema} onClick={cambiarTema} />
        </div>
      </header>

      <div>

        {/* TABS */}
        <div className="el-tabs" style={{ marginBottom: 16 }}>
          <Pills label="Secciones" value={tab} onChange={setTab} options={tabs.map(t => ({ v: t.id, t: t.label }))} />
          {chainLabel && (
            <div className="el-chain">
              <span>{chainLabel}</span>
              <Pills label={chainLabel} value={filterClass} onChange={changeChain}
                options={[{ v: "all", t: "Todas" }, ...chains.map(c => ({ v: c, t: c.toLowerCase().replace(/(^|\s)\S/g, s => s.toUpperCase()) }))]} />
            </div>
          )}
        </div>

        {/* FILTERS */}
        <div style={{ marginBottom: 16 }}>
          <Filtros acciones={<span className="el-count"><b>{filtered.length.toLocaleString("es-MX")}</b> productos</span>}>
            <Buscador etiqueta="Buscar" value={searchTerm} onChange={setSearchTerm} placeholder="SKU, EAN, nombre, brand…" aria="Buscar SKU, EAN, nombre o brand" />
            <Sel label="Departamento" value={filterDept} onChange={changeDept} options={opcionesFiltro("Todos los departamentos", departments)} />
            <Sel label="Categoría" value={filterCat} onChange={changeCat} options={opcionesFiltro("Todas las categorías", categories)} />
            {!chainLabel && <Sel label="Clasificación" value={filterClass} onChange={setFilterClass} options={opcionesFiltro("Todas las clasificaciones", classifications)} />}
          </Filtros>
        </div>

        {/* ═══ 1 · PERFORMANCE DE VENTAS ═══ */}
        {tab === "performance" && <ErrBoundary name="Performance">{(() => {
          if (!perf || !perfWin) return <div className="el-card el-empty">Se necesitan al menos 2 meses de historia para comparar periodos.</div>;
          const d = perf;
          const dR = d.R1 - d.R0;
          const dRPct = d.R0 > 0 ? (dR / d.R0) * 100 : null;
          const dQPct = d.Q0 > 0 ? ((d.Q1 - d.Q0) / d.Q0) * 100 : null;
          const P1 = d.Q1 > 0 ? d.R1 / d.Q1 : 0, P0 = d.Q0 > 0 ? d.R0 / d.Q0 : 0;
          const dPPct = P0 > 0 ? ((P1 - P0) / P0) * 100 : null;
          const tone = (x) => (x >= 0 ? "pos" : "neg");
          const showChain = chainLabel && filterClass === "all";
          const DIMS = [...(showChain ? [{ v: "chain", t: `${chainLabel}s` }] : []), { v: "brand", t: "Marcas" }, { v: "category", t: "Categorías" }, { v: "department", t: "Departamentos" }];
          const dimLabel = { chain: (chainLabel || "").toLowerCase(), brand: "marca", category: "categoría", department: "departamento" }[perfDim];
          const movers = d.rows.filter(r => !perfFocus || (r[perfDim] || "Sin clasificar") === perfFocus);
          const top = (sign) => movers.filter(r => sign * r.delta > 0).sort((a, b) => sign * (b.delta - a.delta)).slice(0, 10);
          // Cascada: venta anterior → aportaciones → venta actual. Las aportaciones suman exacto R1 − R0 en ambas vistas.
          let steps;
          if (perfBridge === "pv") {
            // Nombres en lenguaje de negocio; los pasos en cero no se dibujan
            steps = [
              { name: "Cambio de precio", v: d.bridge.price },
              { name: d.bridge.volume >= 0 ? "Más piezas" : "Menos piezas", v: d.bridge.volume },
              { name: "Productos nuevos", v: d.bridge.added },
              { name: "Productos que salieron", v: d.bridge.lost },
            ].filter(s => Math.round(s.v) !== 0);
          } else {
            const keyOf = perfBridge === "group" ? (r) => r[d.groupKey] || "Sin clasificar"
              : perfBridge === "chain" ? (r) => r.chain || "Sin clasificar"
              : perfBridge === "brand" ? (r) => r.brand || "Sin marca"
              : (r) => r.sku_des;
            const byG = {};
            for (const r of d.rows) { const g = keyOf(r); byG[g] = (byG[g] || 0) + r.delta; }
            const sorted = Object.entries(byG).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
            steps = sorted.slice(0, 6).map(([name, v]) => ({ name, v }));
            const rest = sorted.slice(6).reduce((s, [, v]) => s + v, 0);
            if (sorted.length > 6) steps.push({ name: `Resto (${sorted.length - 6})`, v: rest });
          }
          let run = d.R0;
          const waterfall = [{ name: "Antes", full: fmtRange(perfWin.prev), base: 0, h: d.R0, v: d.R0, total: true, lbl: fmtCompact(d.R0) }];
          for (const s of steps) {
            const end = run + s.v;
            waterfall.push({ name: s.name, base: Math.min(run, end), h: Math.abs(s.v), v: s.v, lbl: `${s.v >= 0 ? "+" : ""}${fmtCompact(s.v)}` });
            run = end;
          }
          waterfall.push({ name: "Ahora", full: fmtRange(perfWin.cur), base: 0, h: d.R1, v: d.R1, total: true, lbl: fmtCompact(d.R1) });

          // Lectura en lenguaje llano de la cascada (para quien no lee gráficas de puente)
          const story = (() => {
            const head = <>La venta {dR >= 0 ? "subió" : "bajó"} de <b>{fmtCompact(d.R0)}</b> a <b>{fmtCompact(d.R1)}</b> ({fmtMoney(dR, true)}, {fmtPct(dRPct, 1, true)}).</>;
            if (perfBridge === "pv") {
              const b = d.bridge, items = [];
              if (Math.round(b.volume)) items.push(<li key="v">{b.volume >= 0 ? "Vendimos más piezas" : "Vendimos menos piezas"}: eso {b.volume >= 0 ? "sumó" : "restó"} <b className={`el-t-${tone(b.volume)}`}>{fmtCompact(b.volume)}</b>.</li>);
              if (Math.round(b.price)) items.push(<li key="p">Los precios {b.price >= 0 ? "subieron" : "bajaron"} y eso {b.price >= 0 ? "sumó" : "restó"} <b className={`el-t-${tone(b.price)}`}>{fmtCompact(b.price)}</b>.</li>);
              if (Math.round(b.added)) items.push(<li key="n">{fmtInt(d.added)} productos nuevos aportaron <b className="el-t-pos">{fmtCompact(b.added)}</b>.</li>);
              if (Math.round(b.lost)) items.push(<li key="l">{fmtInt(d.lostN)} productos que dejaron de venderse restaron <b className="el-t-neg">{fmtCompact(b.lost)}</b>.</li>);
              return { head, items };
            }
            const ups = steps.filter(s => s.v > 0 && !s.name.startsWith("Resto")).slice(0, 2);
            const downs = steps.filter(s => s.v < 0 && !s.name.startsWith("Resto")).slice(0, 2);
            const items = [];
            if (ups.length) items.push(<li key="u">Lo que más empujó: {ups.map((s, i) => <span key={s.name}>{i ? " y " : ""}<b>{s.name}</b> (<span className="el-t-pos">{fmtCompact(s.v)}</span>)</span>)}.</li>);
            if (downs.length) items.push(<li key="d">Lo que más frenó: {downs.map((s, i) => <span key={s.name}>{i ? " y " : ""}<b>{s.name}</b> (<span className="el-t-neg">{fmtCompact(s.v)}</span>)</span>)}.</li>);
            return { head, items };
          })();
          // El eje no empieza en cero (como toda cascada) para que se lean las aportaciones; los totales se recortan abajo
          const levels = waterfall.flatMap(w => (w.total ? [w.v] : [w.base, w.base + w.h]));
          const lo0 = Math.min(...levels), hi0 = Math.max(...levels);
          const pad = (hi0 - lo0) * 0.35 || hi0 * 0.05;
          const wfDomain = [Math.max(0, lo0 - pad), hi0 + pad * 0.4];
          // Mapa: ejes simétricos acotados para que un outlier no aplaste al resto (los que se salen se dibujan en el borde)
          const lim = (vals) => Math.min(60, Math.max(5, Math.ceil(Math.max(...vals.map(Math.abs), 1) * 1.15)));
          const xm = lim(d.bubbles.map(b => b.x)), ym = lim(d.bubbles.map(b => b.y));
          const clamp = (v, m) => Math.max(-m, Math.min(m, v));
          const labeled = new Set(d.bubbles.slice(0, 8).map(b => b.name));
          if (perfFocus) labeled.add(perfFocus);
          const bubbles = d.bubbles.map(b => ({ ...b, px: clamp(b.x, xm), py: clamp(b.y, ym), label: labeled.has(b.name) ? b.name : "" }));
          const pickBubble = (pt) => {
            const name = pt?.payload?.name ?? pt?.name;
            if (name) setPerfFocus(f => (f === name ? null : name));
          };
          const driver = (r) => {
            if (r.status === "new") return <Badge color="blue">Nuevo</Badge>;
            if (r.status === "lost") return <Badge color="red">Sin venta</Badge>;
            return Math.abs(r.priceEff) >= Math.abs(r.volEff) ? <Badge color="amber">Precio</Badge> : <Badge color="blue">Volumen</Badge>;
          };
          const moversTable = (title, list, emptyMsg) => (
            <div className="el-card el-pad">
              <h4 className="el-h4">{title}</h4>
              {list.length === 0 ? <div className="el-empty">{emptyMsg}</div> : (
                <div style={{ overflowX: "auto" }}>
                  <table className="el-tbl">
                    <thead><tr><th>Producto</th><th>Venta</th><th>Δ venta</th><th>Δ %</th><th>Precio</th><th>Unidades</th><th>Motor</th></tr></thead>
                    <tbody>
                      {list.map(r => (
                        <tr key={r.sku} tabIndex={0} title="Ver el análisis del producto" onClick={() => setDetailSku(r.sku)}
                          onKeyDown={e => { if (e.key === "Enter") setDetailSku(r.sku); }}>
                          <td className="el-prod"><b>{r.sku_des}</b><small>{r.sku} · {r.brand || r.category || "—"}</small></td>
                          <td>{fmtMoney(r.r1)}</td>
                          <td className={`el-t-${tone(r.delta)}`}>{fmtMoney(r.delta, true)}</td>
                          <td>{fmtPct(r.deltaPct, 1, true)}</td>
                          <td>{fmtPct(r.pricePct, 1, true)}</td>
                          <td>{fmtPct(r.unitsPct, 1, true)}</td>
                          <td>{driver(r)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
          return (
            <div>
              <SectionHead>Performance de Ventas</SectionHead>
              <div className="el-perf-ctrl">
                <Pills label="Periodo de comparación" value={perfWin.v} onChange={setPerfWindow} options={perfWindows.map(o => ({ v: o.v, t: o.t }))} />
                <span className="el-note">Comparando <b>{fmtRange(perfWin.cur)}</b> contra <b>{fmtRange(perfWin.prev)}</b> · {fmtInt(d.rows.length)} productos con venta</span>
                <button className="el-btn el-btn-sm" onClick={() => downloadCSV([
                  ["SKU", "Descripcion", "Departamento", "Categoria", "Marca", "Venta actual", "Venta anterior", "Delta venta", "Delta %", "Precio prom. actual", "Precio prom. anterior", "Delta precio %", "Unidades actual", "Unidades anterior", "Delta unidades %", "Efecto precio", "Efecto volumen", "Estado"],
                  ...[...d.rows].sort((a, b) => b.delta - a.delta).map(r => [r.sku, r.sku_des, r.department, r.category, r.brand, Math.round(r.r1), Math.round(r.r0), Math.round(r.delta),
                    r.deltaPct?.toFixed(2) ?? "", r.p1?.toFixed(2) ?? "", r.p0?.toFixed(2) ?? "", r.pricePct?.toFixed(2) ?? "", Math.round(r.q1), Math.round(r.q0), r.unitsPct?.toFixed(2) ?? "",
                    Math.round(r.priceEff), Math.round(r.volEff), { both: "continua", new: "nuevo", lost: "sin venta" }[r.status]]),
                ], `performance_${perfWin.cur[0]}_vs_${perfWin.prev[0]}.csv`)}>Descargar detalle (CSV)</button>
              </div>

              <div className="el-flips">
                <FlipCard label="Venta del periodo" value={fmtMoney(d.R1)} tone={tone(dR)} sub={`${fmtPct(dRPct, 1, true)} vs comparación`} backTitle="Venta"
                  back={[
                    { k: fmtRange(perfWin.cur), v: fmtMoney(d.R1) },
                    { k: fmtRange(perfWin.prev), v: fmtMoney(d.R0) },
                    { k: "Diferencia", v: fmtMoney(dR, true), tone: tone(dR) },
                  ]} />
                <FlipCard label="Unidades" value={fmtInt(d.Q1)} sub={`${fmtPct(dQPct, 1, true)} vs comparación`} backTitle="Unidades"
                  back={[
                    { k: fmtRange(perfWin.cur), v: fmtInt(d.Q1) },
                    { k: fmtRange(perfWin.prev), v: fmtInt(d.Q0) },
                    { k: "Diferencia", v: fmtInt(d.Q1 - d.Q0), tone: tone(d.Q1 - d.Q0) },
                  ]} />
                <FlipCard label="Precio promedio" value={fmtPrice(P1)} sub={`${fmtPct(dPPct, 1, true)} · incluye cambio de mezcla`} backTitle="¿Precio o volumen?"
                  back={[
                    { k: "Efecto precio", v: fmtMoney(d.bridge.price, true), tone: tone(d.bridge.price) },
                    { k: "Efecto volumen", v: fmtMoney(d.bridge.volume, true), tone: tone(d.bridge.volume) },
                    { k: "Precio anterior", v: fmtPrice(P0) },
                  ]} />
                <FlipCard label="SKUs creciendo" value={fmtInt(d.growing)} tone="acc" sub={`${fmtInt(d.falling)} cayendo · ${fmtInt(d.added)} nuevos`} backTitle="Movimiento de SKUs"
                  back={[
                    { k: "↑ Creciendo", v: fmtInt(d.growing), tone: "pos" },
                    { k: "↓ Cayendo", v: fmtInt(d.falling), tone: "neg" },
                    { k: "Nuevos (sin venta antes)", v: fmtInt(d.added) },
                    { k: "Sin venta este periodo", v: fmtInt(d.lostN) },
                  ]} />
                <FlipCard label="Top 10 SKUs" value={fmtPct(d.top10Share, 0)} sub="de la venta del periodo" backTitle="Concentración"
                  back={[
                    { k: "SKUs que hacen el 80%", v: `${fmtInt(d.n80)} de ${fmtInt(d.nSelling)}` },
                    { k: "Proporción del catálogo", v: fmtPct((d.n80 / Math.max(d.nSelling, 1)) * 100, 0) },
                  ]} />
              </div>

              <div className="el-grid2">
                <div className="el-card el-pad">
                  <h4 className="el-h4">Venta mensual</h4>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={d.trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tickFormatter={fmtCompact} tick={{ fontSize: 10 }} width={60} />
                      <Tooltip content={<MoneyTip />} />
                      <Bar dataKey="venta" name="Venta" radius={[4, 4, 0, 0]}>
                        {d.trend.map(t => <Cell key={t.month} fill={t.zone === "prev" ? "var(--elc-2)" : "var(--elc-own)"} fillOpacity={t.zone ? 1 : 0.25} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="el-leg">
                    <span><i style={{ background: "var(--elc-own)" }} />Periodo actual</span>
                    <span><i style={{ background: "var(--elc-2)" }} />Periodo de comparación</span>
                  </div>
                </div>
                <div className="el-card el-pad">
                  <div className="el-map-head">
                    <h4 className="el-h4" style={{ margin: 0 }}>¿Qué explica el cambio en venta?</h4>
                    <Pills label="Explicar el cambio por" value={perfBridge} onChange={setPerfBridge}
                      options={[{ v: "pv", t: "Precio y volumen" }, ...(showChain ? [{ v: "chain", t: chainLabel }] : []), { v: "group", t: d.groupKey === "department" ? "Depto." : "Categoría" }, { v: "brand", t: "Marca" }, { v: "sku", t: "SKU" }]} />
                  </div>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={waterfall} margin={{ top: 22, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} tickFormatter={n => (n.length > 13 ? `${n.slice(0, 12)}…` : n)} />
                      <YAxis domain={wfDomain} allowDataOverflow tickFormatter={fmtCompact} tick={{ fontSize: 10 }} width={60} />
                      <Tooltip content={<WaterfallTip />} cursor={{ fill: "var(--db-track-bg)" }} />
                      <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
                      <Bar dataKey="h" stackId="w" radius={[4, 4, 4, 4]}>
                        {waterfall.map(w => <Cell key={w.name} fill={w.total ? "var(--elc-own)" : w.v >= 0 ? "var(--db-pos)" : "var(--db-neg)"} fillOpacity={w.total ? 1 : 0.8} />)}
                        <LabelList dataKey="lbl" position="top" style={{ fontSize: 10.5, fontWeight: 600 }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  {/* Lectura en lenguaje llano: qué pasó, sin necesidad de leer la gráfica */}
                  <div className="el-story">
                    <p>{story.head}</p>
                    {story.items.length > 0 && <ul>{story.items}</ul>}
                  </div>
                  {perfBridge === "pv" ? (
                    <details className="el-how">
                      <summary>¿Cómo se separa el precio de las piezas? Un ejemplo</summary>
                      <p>Un producto vendía <b>100 piezas a $10</b> ($1,000). Ahora vende <b>120 piezas a $9</b> ($1,080): la venta subió <b>$80</b>.</p>
                      <ul>
                        <li><b>Más piezas</b>: 20 piezas extra × el precio de antes ($10) = <span className="el-t-pos">+$200</span>.</li>
                        <li><b>Cambio de precio</b>: las 120 piezas de hoy × $1 menos = <span className="el-t-neg">−$120</span>.</li>
                        <li>Juntas dan exacto el cambio: +$200 − $120 = <b>+$80</b>. Así se lee cada barra, sumando todos los productos.</li>
                      </ul>
                      <p>Los productos que no vendían antes (nuevos) o que ya no vendieron (salieron) van en su propia barra para no confundirlos con un cambio de precio. El eje no empieza en cero para que se vean bien las diferencias.</p>
                    </details>
                  ) : (
                    <p className="el-note">Cada barra es cuánto aportó {{ chain: `cada ${(chainLabel || "").toLowerCase()}`, group: d.groupKey === "department" ? "cada departamento" : "cada categoría", brand: "cada marca", sku: "cada producto" }[perfBridge]} al cambio en pesos: los 6 que más movieron la venta y el resto junto. Verde suma, rojo resta.</p>
                  )}
                </div>
              </div>

              <div className="el-card el-pad" style={{ marginTop: 14 }}>
                <div className="el-map-head">
                  <div>
                    <h4 className="el-h4" style={{ marginBottom: 2 }}>Mapa precio vs volumen</h4>
                    <p className="el-note" style={{ margin: 0 }}>Cómo respondió el volumen de cada {dimLabel} a su propio cambio de precio · tamaño = venta del periodo · clic en una burbuja para ver sus productos abajo</p>
                  </div>
                  <Pills label="Agrupar el mapa por" value={perfDim} onChange={(v) => { setPerfDim(v); setPerfFocus(null); }} options={DIMS} />
                </div>
                {bubbles.length === 0 ? <div className="el-empty">No hay grupos con venta en ambos periodos.</div> : (
                  <ResponsiveContainer width="100%" height={380}>
                    <ScatterChart margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
                      <ReferenceArea x1={0} x2={xm} y1={0} y2={ym} fill="var(--db-pos)" fillOpacity={0.07} stroke="none"
                        label={{ value: "SUBE PRECIO Y GANA VOLUMEN", position: "insideTopRight", fontSize: 10, fill: "var(--db-pos)" }} />
                      <ReferenceArea x1={-xm} x2={0} y1={0} y2={ym} fill="none" stroke="none"
                        label={{ value: "BAJA PRECIO Y GANA VOLUMEN", position: "insideTopLeft", fontSize: 10, fill: "var(--db-ink-2)" }} />
                      <ReferenceArea x1={0} x2={xm} y1={-ym} y2={0} fill="none" stroke="none"
                        label={{ value: "SUBE PRECIO Y PIERDE VOLUMEN", position: "insideBottomRight", fontSize: 10, fill: "var(--db-ink-2)" }} />
                      <ReferenceArea x1={-xm} x2={0} y1={-ym} y2={0} fill="var(--db-neg)" fillOpacity={0.07} stroke="none"
                        label={{ value: "BAJA PRECIO Y AUN ASÍ PIERDE", position: "insideBottomLeft", fontSize: 10, fill: "var(--db-neg)" }} />
                      <CartesianGrid />
                      <XAxis type="number" dataKey="px" domain={[-xm, xm]} tickFormatter={v => `${v > 0 ? "+" : ""}${v}%`} tick={{ fontSize: 10 }}
                        label={{ value: "Δ precio promedio", position: "insideBottom", offset: -4, fontSize: 11 }} />
                      <YAxis type="number" dataKey="py" domain={[-ym, ym]} tickFormatter={v => `${v > 0 ? "+" : ""}${v}%`} tick={{ fontSize: 10 }} width={52}
                        label={{ value: "Δ unidades", angle: -90, position: "insideLeft", offset: 12, fontSize: 11 }} />
                      <ZAxis type="number" dataKey="z" range={[40, 1100]} />
                      <ReferenceLine x={0} stroke="var(--db-ink-3)" />
                      <ReferenceLine y={0} stroke="var(--db-ink-3)" />
                      <Tooltip content={<BubbleTip />} cursor={{ strokeDasharray: "3 3" }} />
                      <Scatter data={bubbles} onClick={pickBubble} cursor="pointer">
                        {bubbles.map(b => (
                          <Cell key={b.name} fill={!perfFocus || perfFocus === b.name ? "var(--elc-own)" : "var(--db-ink-3)"}
                            fillOpacity={perfFocus === b.name ? 0.95 : perfFocus ? 0.25 : 0.55} stroke="var(--db-surface-hi)" />
                        ))}
                        <LabelList dataKey="label" position="top" style={{ fontSize: 10.5, fontWeight: 600 }} />
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                )}
                <p className="el-note">Las {bubbles.length} {perfDim === "brand" ? "marcas" : perfDim === "category" ? "categorías" : "departamentos"} con más venta. Precio y unidades se miden solo con productos que vendieron en ambos periodos, para que la entrada o salida de SKUs no se confunda con un cambio de precio.</p>
              </div>

              {perfFocus && (
                <div className="el-focus">
                  Mostrando productos de <b>{perfFocus}</b>
                  <button className="el-btn el-btn-sm" onClick={() => setPerfFocus(null)}>Quitar filtro</button>
                </div>
              )}
              <div className="el-grid2" style={{ marginTop: perfFocus ? 0 : 14 }}>
                {moversTable("Mayor crecimiento", top(1), "Ningún producto creció con este filtro.")}
                {moversTable("Mayor caída", top(-1), "Ningún producto cayó con este filtro.")}
              </div>

              <div className="el-card el-pad" style={{ marginTop: 14 }}>
                <h4 className="el-h4">Crecimiento por {d.groupKey === "department" ? "departamento" : "categoría"}</h4>
                <ResponsiveContainer width="100%" height={Math.max(160, d.groups.length * 30 + 40)}>
                  <BarChart data={d.groups} layout="vertical" margin={{ top: 4, right: 56, left: 0, bottom: 0 }}>
                    <CartesianGrid horizontal={false} />
                    {/* Holgura a ambos lados para que la etiqueta de cada barra quepa sin pisar los nombres */}
                    <XAxis type="number" domain={[mn => Math.min(0, mn * 1.4), mx => Math.max(0, mx * 1.2)]} tickFormatter={v => `${Math.round(v)}%`} tick={{ fontSize: 10 }} />
                    <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
                    <ReferenceLine x={0} stroke="var(--db-ink-3)" />
                    <Tooltip content={<GroupTip />} />
                    <Bar dataKey="deltaPct" name="Crecimiento">
                      {d.groups.map(g => <Cell key={g.name} fill={g.deltaPct >= 0 ? "var(--db-pos)" : "var(--db-neg)"} fillOpacity={0.75} />)}
                      <LabelList dataKey="deltaPct" content={barEndLabel(v => fmtPct(v, 1, true))} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <p className="el-note">Los 12 {d.groupKey === "department" ? "departamentos" : "categorías"} con mayor cambio en pesos. Elige un departamento en los filtros para bajar a categorías.</p>
              </div>
            </div>
          );
        })()}</ErrBoundary>}

        {/* ═══ PORTFOLIO TAB ═══ */}
        {tab === "portfolio" && <ErrBoundary name="Portfolio">{(() => {
          const withSuggestion = portfolioData.filter(p => p.elasticity !== null);
          const increases = withSuggestion.filter(p => p.pctChange > 0.5);
          const decreases = withSuggestion.filter(p => p.pctChange < -0.5);
          const maintains = withSuggestion.filter(p => Math.abs(p.pctChange) <= 0.5);
          const avgChange = withSuggestion.length > 0 ? withSuggestion.reduce((s, p) => s + p.pctChange, 0) / withSuggestion.length : 0;
          const totalSalesCurrent = withSuggestion.reduce((s, p) => s + p.currentRevenue, 0);
          const totalSalesSuggested = withSuggestion.reduce((s, p) => s + p.suggestedRevenue, 0);
          const approvedSales = withSuggestion.reduce((s, p) => {
            const st = approvals[p.sku];
            if (st === "approved") return s + p.suggestedRevenue;
            return s + p.currentRevenue;
          }, 0);
          const approvedCount = Object.values(approvals).filter(v => v === "approved").length;
          const rejectedCount = Object.values(approvals).filter(v => v === "rejected").length;

          // Enriquezco con cluster info para permitir sort
          const enrichedPortfolio = portfolioData.map(r => {
            const c = clusterInfo.map[r.sku];
            return { ...r, abc: c?.abc || "", subcluster: c?.sub || "" };
          });
          const sortedPortfolio = sortRows(enrichedPortfolio, portfolioSort);
          const pagedPortfolio = sortedPortfolio.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

          return (
            <div>
              <SectionHead ic="💰">Sugerencia de Precios</SectionHead>

              {/* El escenario se elige en Configuración; aquí solo se recuerda cuál está activo */}
              <div className="el-card el-scn">
                <span>Escenario activo: <b>{SCENARIOS[scenario].label}</b></span>
                <button className="el-btn" onClick={() => { setTab("admin"); setAdminSection("scenario"); }}>Cambiar escenario</button>
              </div>

              {/* Nota sobre la metodología del optimizador */}
              <div style={{ background: "var(--db-pos-soft)", border: `1px solid var(--el-pos-line)`, borderLeft: `4px solid ${C.green}`, borderRadius: 10, padding: "12px 14px", marginBottom: 14, fontSize: 11, lineHeight: 1.6, color: C.text }}>
                <div style={{ fontWeight: 700, color: C.navy, marginBottom: 4 }}>⚙️ Cómo trabaja el optimizador</div>
                El optimizador busca numéricamente dentro del rango ±30% el precio que maximiza
                <code style={{ background: "var(--db-pos-soft)", padding: "1px 6px", borderRadius: 4, margin: "0 4px" }}>P·Q(P)</code>
                bajo
                <code style={{ background: "var(--db-pos-soft)", padding: "1px 6px", borderRadius: 4, margin: "0 4px" }}>Q = Q₀·(P/P₀)^E</code>,
                garantizando que el ingreso proyectado sea siempre ≥ el actual. Elasticidades con <strong>E ≥ 0 (Giffen/atípica)</strong> se tratan como <em>sin señal</em> → mantener precio.
                El volumen proyectado se acota a <strong>±5×</strong> el actual para evitar proyecciones infinitas en outliers.
              </div>

              {/* KPIs en un renglón: cada tarjeta gira para mostrar su desglose */}
              {(() => {
                const n = withSuggestion.length;
                const share = (x) => `${((x / Math.max(n, 1)) * 100).toFixed(0)}%`;
                const byConf = { alta: 0, media: 0, baja: 0, muy_baja: 0 };
                withSuggestion.forEach(r => { byConf[r.confidence] = (byConf[r.confidence] || 0) + 1; });
                const autoOk = byConf.alta + byConf.media;
                const changes = withSuggestion.map(p => p.pctChange).sort((a, b) => a - b);
                const median = n ? (n % 2 ? changes[(n - 1) / 2] : (changes[n / 2 - 1] + changes[n / 2]) / 2) : 0;
                const deltaSug = totalSalesSuggested - totalSalesCurrent;
                const deltaApr = approvedSales - totalSalesCurrent;
                const pending = n - approvedCount - rejectedCount;
                return (
                  <div className="el-flips">
                    <FlipCard label="Productos analizados" value={fmtInt(n)}
                      sub={`↑ ${increases.length} · ↓ ${decreases.length} · = ${maintains.length}`} backTitle="Dirección del precio"
                      back={[
                        { k: "↑ Subir precio", v: `${increases.length} · ${share(increases.length)}` },
                        { k: "↓ Bajar precio", v: `${decreases.length} · ${share(decreases.length)}` },
                        { k: "= Mantener", v: `${maintains.length} · ${share(maintains.length)}` },
                      ]} />
                    <FlipCard label="Cambio promedio" value={fmtPct(avgChange, 2, true)} tone="acc" sub="vs precio actual" backTitle="Rango de cambios"
                      back={[
                        { k: "Mediana", v: fmtPct(median, 2, true) },
                        { k: "Mayor alza", v: fmtPct(changes[n - 1] ?? 0, 1, true), tone: "pos" },
                        { k: "Mayor baja", v: fmtPct(changes[0] ?? 0, 1, true), tone: "neg" },
                      ]} />
                    <FlipCard label="Auto-aplicables" value={fmtInt(autoOk)} sub={`${share(autoOk)} con confianza alta o media`} backTitle="Confianza del modelo"
                      back={[
                        { k: "✓ Alta · MAPE < 20%", v: byConf.alta, tone: "pos" },
                        { k: "✓ Media · MAPE 20–40%", v: byConf.media, tone: "pos" },
                        { k: "⚠ Revisar · MAPE 40–60%", v: byConf.baja, tone: "warn" },
                        { k: "✗ No aplicar · > 60% o sin señal", v: byConf.muy_baja, tone: "neg" },
                      ]} />
                    <FlipCard label="Venta proyectada" value={fmtMoney(totalSalesSuggested)} tone={deltaSug >= 0 ? "pos" : "neg"}
                      sub={`${fmtPct((deltaSug / Math.max(totalSalesCurrent, 1)) * 100, 1, true)} vs ${fmtCompact(totalSalesCurrent)} actual`} backTitle="Venta del último mes"
                      back={[
                        { k: "Actual (precio × unidades)", v: fmtMoney(totalSalesCurrent) },
                        { k: "Con todos los sugeridos", v: fmtMoney(totalSalesSuggested) },
                        { k: "Diferencia", v: fmtMoney(deltaSug, true), tone: deltaSug >= 0 ? "pos" : "neg" },
                      ]} />
                    <FlipCard label="Venta con aprobados" value={fmtMoney(approvedSales)} tone="warn"
                      sub={`✓ ${approvedCount} · ✗ ${rejectedCount} · ${pending} pendientes`} backTitle="Configuración aprobada"
                      back={[
                        { k: "✓ Aprobados", v: approvedCount, tone: "pos" },
                        { k: "✗ Rechazados", v: rejectedCount, tone: "neg" },
                        { k: "Pendientes", v: pending },
                        { k: "Diferencia vs actual", v: fmtMoney(deltaApr, true), tone: deltaApr >= 0 ? "pos" : "neg" },
                      ]} />
                  </div>
                );
              })()}

              {/* Upload + acciones */}
              <div className="el-card" style={{ padding: 12, marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <div style={{ fontSize: 11, color: C.sub, marginRight: 8 }}>
                  <strong style={{ color: C.navy }}>📤 Cargar CSV (UPC + precio)</strong> para sobrescribir el precio sugerido de productos específicos:
                </div>
                <label className="el-btn-pri" style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                  Subir CSV
                  <input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => handlePortfolioUpload(e.target.files?.[0])} />
                </label>
                <button onClick={() => {
                  const sample = "upc,price\n7501008071342,25\n7500478042401,30\n";
                  const blob = new Blob([sample], { type: "text/csv" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a"); a.href = url; a.download = "plantilla_upc_precio.csv"; a.click();
                  URL.revokeObjectURL(url);
                }} className="el-btn" style={{ padding: "7px 12px", fontSize: 11, color: C.sub, cursor: "pointer" }}>
                  Plantilla
                </button>
                {Object.keys(overrides).length > 0 && (
                  <button onClick={() => { setOverrides({}); setUploadInfo(null); }} className="el-btn" style={{ padding: "7px 12px", fontSize: 11, color: C.red, cursor: "pointer" }}>
                    Limpiar overrides ({Object.keys(overrides).length})
                  </button>
                )}
                <div style={{ flex: 1 }} />
                <button onClick={downloadPortfolioCSV} className="el-btn-pri" style={{ padding: "7px 14px",   
                  fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Descargar CSV</button>
                <button onClick={() => {
                  // Auto-aprobar SOLO los productos con confianza Alta/Media (MAPE < 40% y señal válida)
                  // El resto (Baja/Muy baja) queda rechazado automáticamente (usa precio actual)
                  const next = {};
                  let approved = 0, rejected = 0;
                  portfolioData.forEach(r => {
                    if (r.recommendation === "auto_approve") { next[r.sku] = "approved"; approved++; }
                    else if (r.recommendation === "reject") { next[r.sku] = "rejected"; rejected++; }
                  });
                  setApprovals(next);
                  logAudit({
                    action: "BULK_AUTO_DECIDE",
                    detail: `Auto-decisión masiva por confianza: ${approved} aprobados (MAPE<40%), ${rejected} rechazados (MAPE>60% o sin señal)`,
                  });
                }} className="el-btn-pri" style={{
                  padding: "7px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer",
                }}>🤖 Auto-decidir por confianza</button>
                <button onClick={() => {
                  const all = {};
                  portfolioData.forEach(r => { if (r.elasticity !== null) all[r.sku] = "approved"; });
                  setApprovals(all);
                  logAudit({ action: "BULK_APPROVE_ALL", detail: `Aprobar todos: ${Object.keys(all).length} SKUs` });
                }} style={{
                  padding: "7px 12px", borderRadius: 6, border: `1px solid ${C.green}`, background: "var(--db-pos-soft)", color: C.green, fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}>✓ Aprobar todos</button>
                <button onClick={() => {
                  const count = Object.keys(approvals).length;
                  setApprovals({});
                  logAudit({ action: "BULK_CLEAR", detail: `Limpiar ${count} decisiones` });
                }} className="el-btn" style={{ padding: "7px 12px", color: C.sub, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Limpiar decisiones</button>
              </div>

              {uploadError && <div style={{ marginBottom: 10, padding: 10, background: "var(--db-neg-soft)", color: C.red, borderRadius: 8, fontSize: 11 }}>{uploadError}</div>}
              {uploadInfo && (
                <div style={{ marginBottom: 10, padding: 10, background: "var(--db-accent-soft)", borderRadius: 8, fontSize: 11, color: C.text }}>
                  📥 Upload: <strong>{uploadInfo.matched}</strong> productos con precio manual aplicado · {uploadInfo.notFound} UPCs no encontrados · {uploadInfo.invalid} filas inválidas
                </div>
              )}

              <div className="el-card" style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: Object.values(portfolioWidths).reduce((s, w) => s + w, 0), tableLayout: "fixed" }}>
                  <thead>
                    <tr style={{ background: "var(--db-track-bg)", borderBottom: `2px solid ${C.border}` }}>
                      <SortHeader label="Img" widthKey="img" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="SKU" sortKey="sku" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="sku" widths={portfolioWidths} setWidths={setPortfolioWidths} align="left" />
                      <SortHeader label="UPC" sortKey="upc" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="upc" widths={portfolioWidths} setWidths={setPortfolioWidths} align="left" />
                      <SortHeader label="Producto" sortKey="sku_des" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="prod" widths={portfolioWidths} setWidths={setPortfolioWidths} align="left" />
                      <SortHeader label="Categoria" sortKey="category" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="cat" widths={portfolioWidths} setWidths={setPortfolioWidths} align="left" />
                      <SortHeader label="Clase" sortKey="abc" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="abc" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Sub-cluster" sortKey="subcluster" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="sub" widths={portfolioWidths} setWidths={setPortfolioWidths} align="left" />
                      <SortHeader label="Precio Actual" sortKey="currentPrice" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="pa" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Margen" sortKey="currentMargin" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="marg" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Elasticidad" sortKey="elasticity" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="elas" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Método" sortKey="methodName" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="met" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Confianza" sortKey="confidence" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="conf" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Precio Sugerido" sortKey="suggestedPrice" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="ps" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Cambio" sortKey="pctChange" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="ch" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Nuevo Margen" sortKey="newMargin" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="nm" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Comp. Mín" sortKey="compMin" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="cm" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Unid. Actuales" sortKey="lastUnits" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="ua" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Unid. Proyectadas" sortKey="predUnits" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="up" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Venta Actual" sortKey="currentRevenue" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="va" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Venta Proyectada" sortKey="suggestedRevenue" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="vp" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Precio Final" sortKey="priceFinal" sortConfig={portfolioSort} setSortConfig={setPortfolioSort} widthKey="pf" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                      <SortHeader label="Decisión" widthKey="dec" widths={portfolioWidths} setWidths={setPortfolioWidths} />
                    </tr>
                  </thead>
                  <tbody>
                    {pagedPortfolio.map((r, idx) => {
                      const comp = compBySku[r.sku];
                      const compMin = comp?.minPrice;
                      const decision = approvals[r.sku];
                      const decisionRevenue = decision === "approved" ? r.suggestedRevenue : r.currentRevenue;
                      const clust = clusterInfo.map[r.sku];
                      const abcColor = { A: C.green, B: C.blue, C: C.accent, D: C.red };
                      return (
                        <tr key={r.sku} style={{ borderBottom: "1px solid var(--db-track-bg)", background: decision === "approved" ? "var(--db-pos-soft)" : decision === "rejected" ? "var(--db-neg-soft)" : (idx % 2 ? "var(--db-track-bg)" : "transparent") }}>
                          <td style={{ padding: "6px 6px", cursor: "pointer" }} onClick={() => setDetailSku(r.sku)}>
                            <div style={{ width: 30, height: 30, background: "var(--db-track-bg)", borderRadius: 4, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              {comp?.image ? <img src={comp.image} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} onError={e => { e.target.style.display = "none"; }} /> : <span style={{ fontSize: 12, color: C.muted }}>📦</span>}
                            </div>
                          </td>
                          <td style={{ padding: "8px 6px", fontSize: 10, color: C.muted, cursor: "pointer" }} onClick={() => setDetailSku(r.sku)}>{r.sku}</td>
                          <td style={{ padding: "8px 6px", fontSize: 10, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.upc || "-"}</td>
                          <td style={{ padding: "8px 6px", cursor: "pointer", overflow: "hidden" }} onClick={() => setDetailSku(r.sku)}>
                            <div style={{ fontWeight: 600, color: C.navy, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.sku_des || r.sku}</div>
                            <div style={{ fontSize: 9, color: C.muted, display: "flex", alignItems: "center", gap: 4 }}>
                              {r.brand}
                              {r.family && <span style={{ background: "var(--db-accent-soft)", color: C.blue, padding: "1px 6px", borderRadius: 4, fontSize: 8, fontWeight: 700 }}>👪 {r.family}</span>}
                            </div>
                          </td>
                          <td style={{ padding: "8px 6px", fontSize: 10, color: C.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.category}</td>
                          <td style={{ padding: "8px 6px", textAlign: "center" }}>
                            {clust ? <span style={{ padding: "2px 8px", borderRadius: 10, background: abcColor[clust.abc] + "22", color: abcColor[clust.abc], fontWeight: 700, fontSize: 10 }}>{clust.abc}</span> : <span style={{ color: C.muted }}>-</span>}
                          </td>
                          <td style={{ padding: "8px 6px", fontSize: 9, color: C.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{clust ? clust.sub : "-"}</td>
                          <td style={{ padding: "8px 6px", textAlign: "center", fontWeight: 600 }}>${r.currentPrice.toLocaleString("es-MX", { minimumFractionDigits: 2 })}</td>
                          <td style={{ padding: "8px 6px", textAlign: "center", fontSize: 10 }}>{r.currentMargin > 0 ? (r.currentMargin * 100).toFixed(1) + "%" : "-"}</td>
                          <td style={{ padding: "8px 6px", textAlign: "center", fontWeight: 700, color: r.elasticity !== null ? (r.elasticity < -1 ? C.red : r.elasticity < 0 ? C.green : C.accent) : C.muted }}>
                            {r.elasticity !== null ? r.elasticity.toFixed(2) : "-"}
                          </td>
                          <td style={{ padding: "8px 6px", textAlign: "center" }}>{r.methodId ? <MethodBadge method={r.methodId} /> : "-"}</td>
                          <td style={{ padding: "6px 6px", textAlign: "center" }}>
                            <span title={r.confidenceLabel + (r.mape !== null ? ` · MAPE ${r.mape.toFixed(1)}%` : "")} style={{
                              padding: "2px 8px", borderRadius: 10, background: r.confidenceColor + "22",
                              color: r.confidenceColor, fontWeight: 700, fontSize: 9, whiteSpace: "nowrap",
                            }}>
                              {r.confidence === "alta" ? "✓ Alta" :
                               r.confidence === "media" ? "✓ Media" :
                               r.confidence === "baja" ? "⚠ Baja" :
                               "✗ Muy baja"}
                            </span>
                          </td>
                          <td style={{ padding: "4px 6px", textAlign: "center", position: "relative" }}>
                            <input
                              type="number"
                              step="0.01"
                              value={r.suggestedPrice}
                              onChange={(e) => {
                                const v = parseFloat(e.target.value);
                                if (isFinite(v) && v > 0) setOverrides(o => ({ ...o, [r.sku]: v }));
                              }}
                              onBlur={(e) => {
                                const v = parseFloat(e.target.value);
                                if (isFinite(v) && v > 0 && Math.abs(v - r.autoSuggestedPrice) > 0.01) {
                                  logAudit({
                                    action: "OVERRIDE_PRICE", sku: r.sku, sku_des: r.sku_des, family: r.family,
                                    before: r.autoSuggestedPrice, after: v,
                                    detail: `${r.sku_des}: override manual $${r.autoSuggestedPrice} → $${v}`,
                                  });
                                }
                              }}
                              style={{
                                width: "100%", maxWidth: 100, padding: "5px 6px",
                                border: `1px solid ${r.isOverridden ? C.accent : C.border}`,
                                background: r.isOverridden ? "var(--db-warn-soft)" : C.card,
                                borderRadius: 5, fontSize: 11, fontWeight: 700, color: C.navy, textAlign: "center",
                              }}
                            />
                            {r.isOverridden && (
                              <button onClick={() => setOverrides(o => { const n = { ...o }; delete n[r.sku]; return n; })}
                                title="Deshacer override"
                                style={{ marginTop: 2, padding: "1px 4px", fontSize: 9, background: "transparent", border: "none", color: C.muted, cursor: "pointer" }}>
                                ↺ auto
                              </button>
                            )}
                          </td>
                          <td style={{ padding: "8px 6px", textAlign: "center" }}>
                            <Badge color={r.pctChange > 0.5 ? "green" : r.pctChange < -0.5 ? "red" : "blue"}>
                              {r.pctChange > 0 ? "+" : ""}{r.pctChange.toFixed(1)}%
                            </Badge>
                          </td>
                          <td style={{ padding: "8px 6px", textAlign: "center", fontSize: 10, fontWeight: 600, color: r.newMargin === null ? C.muted : r.newMargin < 0 ? C.red : r.newMargin > r.currentMargin ? C.green : C.accent }}>
                            {r.newMargin === null ? "-" : (r.newMargin * 100).toFixed(1) + "%"}
                          </td>
                          <td style={{ padding: "8px 6px", textAlign: "center", fontSize: 10, color: C.sub }}>{compMin ? "$" + compMin.toLocaleString("es-MX") : "-"}</td>
                          <td style={{ padding: "8px 6px", textAlign: "center", fontSize: 10 }}>{r.lastUnits.toLocaleString()}</td>
                          <td style={{ padding: "8px 6px", textAlign: "center", fontSize: 10, fontWeight: 600, color: r.predUnits > r.lastUnits ? C.green : r.predUnits < r.lastUnits ? C.red : C.sub }}>{r.predUnits.toLocaleString()}</td>
                          <td style={{ padding: "8px 6px", textAlign: "center", fontSize: 10, color: C.blue }}>${Math.round(r.currentRevenue).toLocaleString("es-MX")}</td>
                          <td style={{ padding: "8px 6px", textAlign: "center", fontSize: 10, fontWeight: 700, color: decision === "approved" ? C.green : decision === "rejected" ? C.sub : C.navy }}>
                            ${Math.round(decisionRevenue).toLocaleString("es-MX")}
                            {decision === "approved" && <div style={{ fontSize: 8, color: C.green }}>✓ aprobado</div>}
                            {decision === "rejected" && <div style={{ fontSize: 8, color: C.red }}>✗ usa actual</div>}
                          </td>
                          <td style={{ padding: "8px 6px", textAlign: "center", fontWeight: 700, color: decision === "approved" ? C.green : C.navy, background: decision === "approved" ? "var(--db-pos-soft)" : "transparent" }}>
                            ${r.priceFinal.toLocaleString("es-MX", { minimumFractionDigits: 2 })}
                          </td>
                          <td style={{ padding: "8px 6px", textAlign: "center", whiteSpace: "nowrap" }}>
                            <button onClick={() => {
                              const prev = approvals[r.sku] || "pending";
                              const next = prev === "approved" ? null : "approved";
                              setApprovals(a => ({ ...a, [r.sku]: next }));
                              logAudit({
                                action: next === "approved" ? "APPROVE" : "UNAPPROVE",
                                sku: r.sku, sku_des: r.sku_des, family: r.family,
                                before: prev, after: next || "pending",
                                detail: `${r.sku_des}: ${r.currentPrice} → ${r.suggestedPrice} (${r.pctChange}%)`,
                                currentPrice: r.currentPrice, suggestedPrice: r.suggestedPrice,
                              });
                            }}
                              style={{
                                padding: "4px 8px", marginRight: 4, borderRadius: 5, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 700,
                                background: decision === "approved" ? C.green : "var(--db-pos-soft)",
                                color: decision === "approved" ? "var(--db-ink-inverse)" : C.green,
                              }}>✓</button>
                            <button onClick={() => {
                              const prev = approvals[r.sku] || "pending";
                              const next = prev === "rejected" ? null : "rejected";
                              setApprovals(a => ({ ...a, [r.sku]: next }));
                              logAudit({
                                action: next === "rejected" ? "REJECT" : "UNREJECT",
                                sku: r.sku, sku_des: r.sku_des, family: r.family,
                                before: prev, after: next || "pending",
                                detail: `${r.sku_des}: mantiene precio actual $${r.currentPrice}`,
                                currentPrice: r.currentPrice, suggestedPrice: r.suggestedPrice,
                              });
                            }}
                              style={{
                                padding: "4px 8px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 700,
                                background: decision === "rejected" ? C.red : "var(--db-neg-soft)",
                                color: decision === "rejected" ? "var(--db-ink-inverse)" : C.red,
                              }}>✗</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 12, marginBottom: 24 }}>
                <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="el-btn" style={{ padding: "4px 10px", fontSize: 11, cursor: page === 0 ? "default" : "pointer", opacity: page === 0 ? 0.4 : 1 }}>Anterior</button>
                <span style={{ fontSize: 11, color: C.sub }}>{page + 1} / {totalPages || 1}</span>
                <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} className="el-btn" style={{ padding: "4px 10px", fontSize: 11, cursor: page >= totalPages - 1 ? "default" : "pointer", opacity: page >= totalPages - 1 ? 0.4 : 1 }}>Siguiente</button>
              </div>
            </div>
          );
        })()}</ErrBoundary>}

        {/* ═══ CLUSTERS TAB ═══ */}
        {tab === "clusters" && (() => {
          // ABC + k-means vienen de clusterInfo (mismo cálculo que la columna del Portafolio)
          const { rows, groups } = clusterInfo;
          if (!rows.length) {
            return (
              <div style={{ textAlign: "center", padding: 60, color: C.sub, fontSize: 13 }}>
                Ningún producto coincide con los filtros o la búsqueda actuales.
              </div>
            );
          }
          const clusterLabels = Object.fromEntries(Object.entries(clusterInfo.map).map(([sku, c]) => [sku, c.key]));

          // Totales por ABCD
          const abcSummary = ["A", "B", "C", "D"].map(cls => {
            const g = groups[cls];
            const rev = g.reduce((s, r) => s + r.revenue, 0);
            return {
              cls,
              count: g.length,
              revenue: rev,
              avgElast: g.length ? g.reduce((s, r) => s + r.elasticitySafe, 0) / g.length : 0,
            };
          });
          const totalRev = abcSummary.reduce((s, x) => s + x.revenue, 0);

          // Sub-clusters agregados
          const subBuckets = {};
          rows.forEach(r => {
            const key = clusterLabels[r.sku];
            if (!subBuckets[key]) subBuckets[key] = { key, abc: r.abc, sub: key.split("-").slice(1).join("-"), count: 0, revenue: 0, elastSum: 0, elastCount: 0, mapeSum: 0, mapeCount: 0 };
            const b = subBuckets[key];
            b.count++;
            b.revenue += r.revenue;
            b.elastSum += r.elasticitySafe; b.elastCount++;
            if (r.mape !== null && r.mape < 999) { b.mapeSum += r.mape; b.mapeCount++; }
          });
          const subArr = Object.values(subBuckets).map(b => ({
            ...b,
            avgElast: b.elastSum / Math.max(b.elastCount, 1),
            avgMape: b.mapeCount > 0 ? b.mapeSum / b.mapeCount : null,
          })).sort((a, b) => b.revenue - a.revenue);

          const abcColor = { A: C.green, B: C.blue, C: C.accent, D: C.red };

          // Distribución del ingreso por banda de sensibilidad al precio (elasticidad saneada).
          // Reemplaza el scatter: responde "¿cuánto de mi ingreso está en productos donde
          // subir precio es seguro (inelásticos) vs riesgoso (muy elásticos)?".
          const bandDefs = [
            { label: "Sin señal (E=0)", color: C.muted, test: e => e === 0 },
            { label: "Inelástico (0 a -1)", color: C.green, test: e => e < 0 && e > -1 },
            { label: "Elástico (-1 a -2)", color: C.accent, test: e => e <= -1 && e > -2 },
            { label: "Muy elástico (< -2)", color: C.red, test: e => e <= -2 },
          ];
          const totalBandRev = rows.reduce((s, r) => s + r.revenue, 0);
          const elastBands = bandDefs.map(bd => {
            const items = rows.filter(r => bd.test(r.elasticitySafe));
            const revenue = items.reduce((s, r) => s + r.revenue, 0);
            return {
              label: bd.label,
              color: bd.color,
              count: items.length,
              revenue: Math.round(revenue),
              pct: totalBandRev > 0 ? (revenue / totalBandRev) * 100 : 0,
            };
          });
          const inelBand = elastBands[1];   // inelásticos: candidatos seguros a subir precio
          const vhighBand = elastBands[3];  // muy elásticos: riesgo al subir precio

          return (
            <div style={{ paddingBottom: 30 }}>
              <SectionHead ic="🧬">Clusterización del Portafolio</SectionHead>

              <div className="el-card" style={{ padding: 16, marginBottom: 14, fontSize: 11, color: C.sub, lineHeight: 1.6 }}>
                Se corre una <strong>clasificación Pareto ABCD por ingreso</strong> (A: top 70% del revenue, B: +20%, C: +8%, D: últimos 2%). Dentro de cada clase se corre un <strong>k-means (k=3)</strong> sobre 3 features normalizadas: <code>elasticidad</code>, <code>coeficiente de variación de ventas</code> y <code>rango de variación de precios</code>. Esto agrupa productos con comportamiento similar dentro de cada segmento de relevancia para tomar decisiones diferenciadas. Los productos <strong>sin señal de elasticidad</strong> no entran al k-means: forman su propio grupo dentro de cada clase.
              </div>

              {/* ABC summary */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 14 }}>
                {abcSummary.map(x => (
                  <div key={x.cls} style={{ background: C.card, border: `2px solid ${abcColor[x.cls]}`, borderRadius: 10, padding: 14 }}>
                    <div style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Clase {x.cls}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: abcColor[x.cls] }}>{x.count}</div>
                    <div style={{ fontSize: 11, color: C.text, fontWeight: 600 }}>${Math.round(x.revenue).toLocaleString("es-MX")}</div>
                    <div style={{ fontSize: 9, color: C.muted }}>
                      {totalRev > 0 ? ((x.revenue / totalRev) * 100).toFixed(1) : 0}% revenue · E̅={x.avgElast.toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Distribución de ingreso por banda de sensibilidad al precio */}
              <SectionHead ic="📊">Distribución de ingreso por sensibilidad al precio</SectionHead>
              <div className="el-card" style={{ padding: 16, marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: C.sub, marginBottom: 12, lineHeight: 1.5 }}>
                  Cada barra suma el <strong>ingreso total</strong> de los productos que caen en esa banda ("Sin señal" = no hay evidencia de sensibilidad al precio). En vez de un punto por producto, muestra <strong>dónde se concentra tu dinero</strong> según qué tan riesgoso es mover el precio. La etiqueta a la derecha es el % del ingreso analizado.
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={elastBands} layout="vertical" margin={{ top: 6, right: 56, left: 10, bottom: 6 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--db-hair-2)" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 9, fill: C.sub }} tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} />
                    <YAxis type="category" dataKey="label" width={150} tick={{ fontSize: 10, fill: C.text }} />
                    <Tooltip cursor={{ fill: "rgba(0,0,0,0.03)" }} content={<ChartTip />} />
                    <Bar dataKey="revenue" name="Ingreso" radius={[0, 4, 4, 0]}>
                      {elastBands.map((b, i) => <Cell key={i} fill={b.color} />)}
                      <LabelList dataKey="pct" position="right" formatter={v => v.toFixed(0) + "%"} style={{ fontSize: 11, fontWeight: 700, fill: C.sub }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  {elastBands.map((b, i) => (
                    <div key={i} style={{ fontSize: 10, color: C.sub, display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: b.color, display: "inline-block" }} />
                      {b.label}: <strong style={{ color: C.text }}>{b.count} SKUs</strong>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, padding: "10px 12px", background: "var(--db-pos-soft)", borderLeft: `4px solid ${C.green}`, borderRadius: 6, fontSize: 11, color: C.text, lineHeight: 1.55 }}>
                  <strong style={{ color: C.navy }}>💡 Insight:</strong> el <strong style={{ color: C.green }}>{inelBand.pct.toFixed(0)}%</strong> de tu ingreso analizado (${inelBand.revenue.toLocaleString("es-MX")}, {inelBand.count} SKUs) está en productos <strong>inelásticos</strong>: los candidatos más seguros para subir precio, porque el volumen reacciona poco al aumento. En cambio, el <strong style={{ color: C.red }}>{vhighBand.pct.toFixed(0)}%</strong> (${vhighBand.revenue.toLocaleString("es-MX")}) está en productos <strong>muy elásticos</strong>, donde subir precio puede reducir el ingreso total: ahí conviene sostener o bajar precio.
                </div>
              </div>

              {/* Sub-clusters table */}
              <SectionHead ic="🧩">Sub-clusters de Comportamiento (k-means dentro de cada clase ABCD)</SectionHead>
              <div className="el-card" style={{ overflowX: "auto", marginBottom: 14 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: "var(--db-track-bg)", borderBottom: `2px solid ${C.border}` }}>
                      {[
                        { k: "key", h: "Cluster", align: "left" },
                        { k: "abc", h: "Clase ABC", align: "left" },
                        { k: "sub", h: "Perfil", align: "left" },
                        { k: "count", h: "# SKUs" },
                        { k: "revenue", h: "Revenue" },
                        { k: "avgElast", h: "E̅ promedio" },
                        { k: "avgMape", h: "MAPE̅" },
                        { k: null, h: "Acción sugerida" },
                      ].map((col, i) => (
                        <th key={i}
                          onClick={() => col.k && setSubSort(s => ({ key: col.k, dir: s.key === col.k && s.dir === "asc" ? "desc" : "asc" }))}
                          style={{ padding: "10px 8px", textAlign: col.align || "center", color: C.sub, fontWeight: 600, fontSize: 9, textTransform: "uppercase", cursor: col.k ? "pointer" : "default", userSelect: "none" }}>
                          {col.h}
                          {col.k && <span style={{ opacity: subSort.key === col.k ? 1 : 0.3, fontSize: 9, marginLeft: 3 }}>{subSort.key === col.k ? (subSort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortRows(subArr, subSort).map((b, i) => {
                      let action;
                      const absE = Math.abs(b.avgElast);
                      if (b.sub === NO_SIGNAL_CLUSTER) action = "Mantener precio: sin evidencia de sensibilidad al precio";
                      else if (absE >= 1.5) action = "Bajar precio de forma controlada, alta sensibilidad";
                      else if (absE >= 0.7) action = "Analizar caso por caso, evaluar contra competencia";
                      else if (b.avgElast === 0) action = "Revisar datos antes de actuar";
                      else action = "Candidato a subir precio con bajo riesgo";
                      return (
                        <tr key={i} style={{ borderBottom: "1px solid var(--db-track-bg)", background: i % 2 ? "var(--db-track-bg)" : "transparent", cursor: "pointer" }}
                          onClick={() => {
                            const products = rows.filter(r => clusterLabels[r.sku] === b.key)
                              .map(r => ({ ...r, _full: portfolioData.find(pd => pd.sku === r.sku) }));
                            setClusterPopup({ key: b.key, abc: b.abc, sub: b.sub, products, action });
                          }}
                        >
                          <td style={{ padding: "8px 8px", fontSize: 10, color: C.navy, fontWeight: 600 }}>{b.key} <span style={{ color: C.sub, fontWeight: 400 }}>· 🔍 click para ver</span></td>
                          <td style={{ padding: "8px 8px" }}>
                            <span style={{ padding: "2px 8px", borderRadius: 10, background: abcColor[b.abc] + "22", color: abcColor[b.abc], fontWeight: 700, fontSize: 10 }}>{b.abc}</span>
                          </td>
                          <td style={{ padding: "8px 8px", fontSize: 10, color: C.text }}>{b.sub}</td>
                          <td style={{ padding: "8px 8px", textAlign: "center", fontWeight: 700 }}>{b.count}</td>
                          <td style={{ padding: "8px 8px", textAlign: "center" }}>${Math.round(b.revenue).toLocaleString("es-MX")}</td>
                          <td style={{ padding: "8px 8px", textAlign: "center", fontWeight: 600, color: absE >= 1 ? C.red : C.green }}>{b.avgElast.toFixed(2)}</td>
                          <td style={{ padding: "8px 8px", textAlign: "center", fontSize: 10 }}>{b.avgMape !== null ? b.avgMape.toFixed(1) + "%" : "-"}</td>
                          <td style={{ padding: "8px 8px", fontSize: 10, color: C.sub }}>{action}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ background: "var(--db-accent-soft)", border: `1px solid var(--el-info-line)`, borderRadius: 10, padding: 14, fontSize: 11, color: C.text, lineHeight: 1.6 }}>
                <div style={{ fontWeight: 700, color: C.navy, marginBottom: 4 }}>💡 Cómo leer esto</div>
                Los productos <strong>clase A</strong> concentran la mayor parte del ingreso y merecen decisiones tomadas una por una. Dentro de A, el sub-cluster "Elásticos" es el más peligroso de subir precio — el volumen reacciona más que el margen ganado. Los <strong>inelásticos estables</strong> de clase A suelen ser los mejores candidatos para optimización de precio porque mueven mucho ingreso con poco riesgo. Las clases C y D son típicamente candidatos a racionalización de surtido.
              </div>
            </div>
          );
        })()}

        {/* ═══ CONFIGURACIÓN (Escenario · Reglas · Familias · Auditoría en sub-secciones) ═══ */}
        {tab === "admin" && (
          <div className="el-tabs" style={{ marginBottom: 4 }}>
            <Pills label="Configuración" value={adminSection} onChange={setAdminSection}
              options={[{ v: "scenario", t: "Escenario de precios" }, { v: "rules", t: "Reglas de negocio" }, { v: "families", t: "Familias y precio por familia" }, { v: "audit", t: "Auditoría" }]} />
          </div>
        )}

        {/* ── Configuración › Escenario ── */}
        {tab === "admin" && adminSection === "scenario" && (() => {
          // Impacto de cada escenario sobre el portafolio filtrado, para comparar antes de elegir
          const scenarioComparison = Object.keys(SCENARIOS).map(key => {
            const sc = SCENARIOS[key];
            const rules = sc.rules ? { ...businessRules, ...sc.rules } : businessRules;
            let totalCurrent = 0, totalProjected = 0, up = 0, down = 0, noChange = 0;
            for (const p of portfolioData) {
              if (p.elasticity === null) continue;
              const compMin = compBySku[p.sku]?.minPrice;
              const fam = familyRules[p.sku];
              const eff = { ...rules, ...(categoryRules[p.category] || {}), ...(fam && familyBusinessRules[fam] ? familyBusinessRules[fam] : {}) };
              const ruled = applyBusinessRules(p.autoSuggestedPrice ?? p.suggestedPrice, p.currentPrice, p.currentMargin, compMin, eff);
              const pf = ruled.finalPrice;
              const predQ = predictUnits(p.lastUnits, p.currentPrice, pf, p.elasticity);
              totalCurrent += p.currentPrice * p.lastUnits;
              totalProjected += pf * predQ;
              const delta = pf - p.currentPrice;
              if (Math.abs(delta) < 0.01) noChange++;
              else if (delta > 0) up++;
              else down++;
            }
            return { key, ...sc, totalCurrent, totalProjected, up, down, noChange };
          });
          return (
            <div style={{ paddingBottom: 30 }}>
              <SectionHead>Escenario de Precios</SectionHead>
              <p className="el-note" style={{ marginTop: -4, marginBottom: 12 }}>
                Cada escenario aplica un conjunto distinto de reglas globales sobre los mismos modelos de elasticidad. Las reglas por familia siempre tienen prioridad. El escenario elegido se refleja de inmediato en la Sugerencia de precios.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
                {scenarioComparison.map(sc => {
                  const isActive = scenario === sc.key;
                  const deltaPct = sc.totalCurrent > 0 ? ((sc.totalProjected - sc.totalCurrent) / sc.totalCurrent) * 100 : 0;
                  const choose = () => {
                    setScenario(sc.key);
                    logAudit({ action: "SCENARIO_CHANGE", detail: `Escenario: ${sc.label}`, before: scenario, after: sc.key });
                  };
                  return (
                    <div key={sc.key} role="button" tabIndex={0} aria-pressed={isActive} className={`el-opt${isActive ? " on" : ""}`}
                      onClick={choose} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } }}>
                      <div className="el-opt-t" style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{sc.label}</div>
                      <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.5, marginBottom: 8 }}>{sc.desc}</div>
                      <div style={{ fontSize: 11, color: C.sub }}>
                        Venta proyectada: <strong className={`el-t-${deltaPct >= 0 ? "pos" : "neg"}`}>{fmtPct(deltaPct, 1, true)}</strong>
                        {" · ↑"}{sc.up} ↓{sc.down} ={sc.noChange}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* ── Configuración › Reglas de negocio y Familias ── */}
        {tab === "admin" && (adminSection === "rules" || adminSection === "families") && (() => {
          // Agrupa SKUs por familia
          const families = {};
          for (const sku of Object.keys(familyRules)) {
            const fam = familyRules[sku];
            if (!families[fam]) families[fam] = [];
            families[fam].push(sku);
          }
          const familyList = Object.entries(families).map(([name, skus]) => {
            const products = skus.map(s => data.products.find(p => p.sku === s)).filter(Boolean);
            const totalUnits = products.reduce((s, p) => {
              const lm = p.series[p.series.length - 1];
              return s + (lm?.units || 0);
            }, 0);
            const avgPrice = products.length > 0
              ? products.reduce((s, p) => {
                  const lm = p.series[p.series.length - 1];
                  return s + (lm?.price || 0);
                }, 0) / products.length
              : 0;
            const agg = familyAggregates[name];
            const analysis = agg ? analyzeElasticity(agg.series) : null;
            // Rango de precios de hoy entre los SKUs: si no es un solo precio, la familia está desalineada en tienda
            const lastPrices = products.map(p => p.series[p.series.length - 1]?.price).filter(x => x > 0);
            const minP = lastPrices.length ? Math.min(...lastPrices) : 0, maxP = lastPrices.length ? Math.max(...lastPrices) : 0;
            return { name, skus, products, totalUnits, avgPrice, analysis, minP, maxP };
          }).sort((a, b) => b.totalUnits - a.totalUnits);

          // El formulario de reglas edita el alcance elegido: global o una categoría. En una categoría, vacío = hereda
          // la global (la llave se borra para que el merge no la sobreescriba con null).
          const editRules = ruleScope === "global" ? businessRules : (categoryRules[ruleScope] || {});
          const setEditRules = (fn) => {
            if (ruleScope === "global") { setBusinessRules(fn); return; }
            setCategoryRules(cr => {
              const next = fn(cr[ruleScope] || {});
              const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== null && v !== undefined && !(typeof v === "number" && !isFinite(v))));
              const n = { ...cr };
              if (Object.keys(clean).length) n[ruleScope] = clean; else delete n[ruleScope];
              return n;
            });
          };
          const ph = (k, fallback) => {
            if (ruleScope === "global") return fallback;
            const g = businessRules[k];
            return g === null || g === undefined ? "sin regla" : `global: ${g}`;
          };

          const handleFamilyUpload = (file) => {
            if (!file || !data) return;
            setFamilyUploadMsg("");
            const reader = new FileReader();
            reader.onload = (ev) => {
              try {
                const text = String(ev.target.result).replace(/^\uFEFF/, "");
                // Papa respeta comillas (las descripciones del layout traen comas) y detecta "," o ";" (Excel en español)
                const parsed = Papa.parse(text, { skipEmptyLines: "greedy" }).data.filter(r => !String(r[0] ?? "").startsWith("#"));
                if (parsed.length < 2) { setFamilyUploadMsg("Archivo vacío"); return; }
                const header = parsed[0].map(h => String(h).trim().toLowerCase());
                const famIdx = header.findIndex(h => h === "family" || h === "familia" || h === "family_name");
                const upcIdx = header.findIndex(h => h === "upc" || h === "ean");
                const skuIdx = header.findIndex(h => h === "sku");
                const priceIdx = header.findIndex(h => h === "precio_familia" || h === "family_price");
                // Columnas opcionales de reglas específicas
                const ruleCols = {
                  maxPctChange: header.findIndex(h => h === "max_pct_change"),
                  minMarginPct: header.findIndex(h => h === "min_margin_pct"),
                  maxMarginPct: header.findIndex(h => h === "max_margin_pct"),
                  minPriceFloor: header.findIndex(h => h === "min_price_floor"),
                  maxPriceCeiling: header.findIndex(h => h === "max_price_ceiling"),
                  priceAboveCompMin: header.findIndex(h => h === "price_above_comp_min"),
                  roundingMode: header.findIndex(h => h === "rounding_mode"),
                };
                if (famIdx < 0 || (upcIdx < 0 && skuIdx < 0)) {
                  setFamilyUploadMsg("El CSV debe tener columnas 'family' y 'upc' (o 'sku')");
                  return;
                }
                const next = { ...familyRules };
                const nextRules = { ...familyBusinessRules };
                const nextPrices = { ...familyPrices };
                let matched = 0, notFound = 0, rulesApplied = 0, pricesSet = 0;
                for (let i = 1; i < parsed.length; i++) {
                  const parts = parsed[i].map(x => String(x ?? "").trim());
                  const fam = parts[famIdx];
                  if (!fam) continue;
                  let prod = null;
                  if (upcIdx >= 0) {
                    const nu = normUpc(parts[upcIdx]);
                    if (nu) prod = data.products.find(p => normUpc(p.upc) === nu);
                  }
                  if (!prod && skuIdx >= 0) {
                    prod = data.products.find(p => String(p.sku) === String(parts[skuIdx]));
                  }
                  if (!prod) { notFound++; continue; }
                  next[prod.sku] = fam;
                  matched++;
                  // Precio fijo de familia: la primera fila con precio de cada familia lo define
                  const famPrice = priceIdx >= 0 ? parseFloat(String(parts[priceIdx]).replace(/[$,\s]/g, "")) : NaN;
                  if (isFinite(famPrice) && famPrice > 0 && nextPrices[fam] === familyPrices[fam]) {
                    nextPrices[fam] = Math.round(famPrice * 100) / 100;
                    pricesSet++;
                  }
                  // Extraer reglas (una sola vez por familia — primera fila gana)
                  if (!nextRules[fam]) {
                    const famRules = {};
                    let hasAny = false;
                    for (const [k, idx] of Object.entries(ruleCols)) {
                      if (idx < 0) continue;
                      const raw = parts[idx];
                      if (!raw) continue;
                      if (k === "roundingMode") { famRules[k] = raw; hasAny = true; }
                      else {
                        const v = parseFloat(raw);
                        if (isFinite(v)) { famRules[k] = v; hasAny = true; }
                      }
                    }
                    if (hasAny) { nextRules[fam] = famRules; rulesApplied++; }
                  }
                }
                setFamilyRules(next);
                setFamilyBusinessRules(nextRules);
                setFamilyPrices(nextPrices);
                logAudit({ action: "FAMILY_UPLOAD", detail: `${matched} SKUs en familias · ${pricesSet} precios de familia` });
                setFamilyUploadMsg(`✓ ${matched} productos asignados · ${notFound} no encontrados · ${pricesSet} familias con precio fijo · ${rulesApplied} con reglas específicas`);
              } catch (err) { setFamilyUploadMsg("Error: " + err.message); }
            };
            reader.readAsText(file);
          };

          return (
            <div style={{ paddingBottom: 30 }}>
              {adminSection === "rules" && (<>
              <SectionHead ic="⚖️">Reglas de Negocio</SectionHead>

              {/* Alcance: todo el portafolio o una categoría; precedencia familia > categoría > escenario > global */}
              <div className="el-card el-scope">
                <Sel label="Aplicar a" value={ruleScope} onChange={setRuleScope}
                  options={[{ v: "global", t: "Todo el portafolio (global)" }, ...allCategories.map(c => ({ v: c, t: `Categoría: ${c}${categoryRules[c] ? " ●" : ""}` }))]} />
                <div className="el-note" style={{ margin: 0, flex: 1, minWidth: 240 }}>
                  {ruleScope === "global"
                    ? <>Estas reglas aplican a todo el portafolio. Para una categoría con necesidades distintas, elígela arriba: solo los campos que llenes ahí reemplazan a los globales.</>
                    : <>Editando <b>{ruleScope}</b>: deja un campo vacío para usar la regla global (se muestra en gris). Precedencia: <b>familia &gt; categoría &gt; escenario &gt; global</b>.</>}
                </div>
                {Object.keys(categoryRules).length > 0 && (
                  <div className="el-scope-list">
                    <span>Categorías con reglas propias:</span>
                    {Object.keys(categoryRules).sort().map(c => (
                      <button key={c} className={`el-btn el-btn-sm${ruleScope === c ? " on" : ""}`} onClick={() => setRuleScope(c)}>{c}</button>
                    ))}
                  </div>
                )}
              </div>

              <div className="el-card" style={{ padding: 18, marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.6, marginBottom: 14 }}>
                  Estas reglas se aplican <strong>antes de mostrar el precio sugerido</strong> en el Portafolio. Si una regla se activa y modifica el precio, la razón queda registrada en la columna de razón. Deja un campo vacío para desactivar esa regla.
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Cambio máximo vs precio actual</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <input type="number" min="0" max="100" step="1"
                        value={editRules.maxPctChange ?? ""}
                        placeholder={ph("maxPctChange", "30")}
                        onChange={(e) => setEditRules(r => ({ ...r, maxPctChange: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        className="el-field" style={{ width: 80, padding: "8px 10px", borderRadius: 6, fontSize: 12 }}
                      />
                      <span style={{ fontSize: 12, color: C.sub }}>% (±)</span>
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Limita cuánto puede subir o bajar el precio sugerido respecto al actual. <em>Por defecto 30%.</em></div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Margen mínimo permitido</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <input type="number" min="0" max="100" step="1"
                        value={editRules.minMarginPct ?? ""}
                        onChange={(e) => setEditRules(r => ({ ...r, minMarginPct: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        placeholder={ph("minMarginPct", "ej. 15")}
                        className="el-field" style={{ width: 80, padding: "8px 10px", borderRadius: 6, fontSize: 12 }}
                      />
                      <span style={{ fontSize: 12, color: C.sub }}>%</span>
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Evita sugerir bajar precio hasta que el margen caiga debajo de este valor.</div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Margen máximo permitido</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <input type="number" min="0" max="100" step="1"
                        value={editRules.maxMarginPct ?? ""}
                        onChange={(e) => setEditRules(r => ({ ...r, maxMarginPct: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        placeholder={ph("maxMarginPct", "ej. 60")}
                        className="el-field" style={{ width: 80, padding: "8px 10px", borderRadius: 6, fontSize: 12 }}
                      />
                      <span style={{ fontSize: 12, color: C.sub }}>%</span>
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Capa precio para no superar un margen objetivo (útil para productos regulados o KVI).</div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Max sobre competencia mínima</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <input type="number" step="1"
                        value={editRules.priceAboveCompMin ?? ""}
                        onChange={(e) => setEditRules(r => ({ ...r, priceAboveCompMin: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        placeholder={ph("priceAboveCompMin", "ej. 5")}
                        className="el-field" style={{ width: 80, padding: "8px 10px", borderRadius: 6, fontSize: 12 }}
                      />
                      <span style={{ fontSize: 12, color: C.sub }}>%</span>
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Capa el sugerido para que no esté más de X% arriba del competidor más barato.</div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Piso absoluto</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <span style={{ fontSize: 12, color: C.sub }}>$</span>
                      <input type="number" step="0.01" min="0"
                        value={editRules.minPriceFloor ?? ""}
                        onChange={(e) => setEditRules(r => ({ ...r, minPriceFloor: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        placeholder={ph("minPriceFloor", "0")}
                        className="el-field" style={{ width: 100, padding: "8px 10px", borderRadius: 6, fontSize: 12 }}
                      />
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Precio mínimo global (sin importar la sugerencia).</div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Techo absoluto</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <span style={{ fontSize: 12, color: C.sub }}>$</span>
                      <input type="number" step="0.01" min="0"
                        value={editRules.maxPriceCeiling ?? ""}
                        onChange={(e) => setEditRules(r => ({ ...r, maxPriceCeiling: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        placeholder={ph("maxPriceCeiling", "sin límite")}
                        className="el-field" style={{ width: 100, padding: "8px 10px", borderRadius: 6, fontSize: 12 }}
                      />
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Precio máximo global.</div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Redondeo psicológico</label>
                    <select
                      value={editRules.roundingMode ?? ""}
                      onChange={(e) => setEditRules(r => ({ ...r, roundingMode: e.target.value || null }))}
                      className="el-field" style={{ width: "100%", padding: "8px 10px", borderRadius: 6, fontSize: 12, marginTop: 4 }}
                    >
                      {ruleScope !== "global" && <option value="">Igual que la regla global</option>}
                      <option value="none">Ninguno (2 decimales)</option>
                      <option value="integer">Entero</option>
                      <option value="ending_99">Terminación .99</option>
                      <option value="ending_95">Terminación .95</option>
                      <option value="nearest_5">Múltiplo de 5</option>
                    </select>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Aplica patrón de pricing psicológico al precio final.</div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Si el modelo no es confiable</label>
                    <select
                      value={editRules.lowConfidence ?? ""}
                      onChange={(e) => {
                        const v = e.target.value || null;
                        setEditRules(r => ({ ...r, lowConfidence: v }));
                        logAudit({ action: "RULES_LOW_CONFIDENCE", detail: `${ruleScope === "global" ? "Global" : ruleScope} · sin modelo confiable: ${v === "hold" ? "mantener precio" : v === "suggest" ? "sugerir de todos modos" : "igual que global"}` });
                      }}
                      className="el-field" style={{ width: "100%", padding: "8px 10px", borderRadius: 6, fontSize: 12, marginTop: 4 }}
                    >
                      {ruleScope !== "global" && <option value="">Igual que la regla global</option>}
                      <option value="hold">Mantener el precio actual (recomendado)</option>
                      <option value="suggest">Sugerir precio de todos modos</option>
                    </select>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Aplica a productos con error del modelo &gt; 60% o sin señal de elasticidad (confianza "No aplicar").</div>
                  </div>
                </div>

                <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => {
                    if (ruleScope === "global") {
                      setBusinessRules({
                        maxPctChange: 30, minMarginPct: null, maxMarginPct: null,
                        minPriceFloor: null, maxPriceCeiling: null,
                        priceAboveCompMin: null, roundingMode: "none", lowConfidence: "hold",
                      });
                      logAudit({ action: "RULES_RESET_GLOBAL", detail: "Reset reglas de negocio globales a default" });
                    } else {
                      setCategoryRules(cr => { const n = { ...cr }; delete n[ruleScope]; return n; });
                      logAudit({ action: "RULES_RESET_CATEGORY", detail: `Quitar reglas propias de la categoría ${ruleScope}` });
                    }
                  }} className="el-btn" style={{ padding: "7px 14px", color: C.sub, fontSize: 11, cursor: "pointer" }}>
                    {ruleScope === "global" ? "Resetear valores" : "Quitar reglas de esta categoría"}
                  </button>
                  <div style={{ flex: 1, fontSize: 11, color: C.sub, alignSelf: "center" }}>
                    <strong style={{ color: C.navy }}>Activas ahora:</strong>{" "}
                    {[
                      editRules.maxPctChange ? `cambio máx ${editRules.maxPctChange}%` : null,
                      editRules.minMarginPct ? `margen mín ${editRules.minMarginPct}%` : null,
                      editRules.maxMarginPct ? `margen máx ${editRules.maxMarginPct}%` : null,
                      editRules.priceAboveCompMin !== null ? `max ${editRules.priceAboveCompMin}% vs comp.` : null,
                      editRules.minPriceFloor ? `piso $${editRules.minPriceFloor}` : null,
                      editRules.maxPriceCeiling ? `techo $${editRules.maxPriceCeiling}` : null,
                      editRules.roundingMode !== "none" ? `redondeo ${editRules.roundingMode}` : null,
                    ].filter(Boolean).join(" · ") || "ninguna"}
                  </div>
                </div>
              </div>

              </>)}

              {adminSection === "families" && (<>
              <SectionHead ic="📋">Familias y Precio por Familia</SectionHead>

              <div style={{ background: "var(--db-accent-soft)", border: `1px solid var(--el-info-line)`, borderLeft: `4px solid ${C.blue}`, borderRadius: 10, padding: 14, marginBottom: 14, fontSize: 11, lineHeight: 1.6, color: C.text }}>
                <div style={{ fontWeight: 700, color: C.navy, marginBottom: 4 }}>💡 Cómo funciona</div>
                Carga un CSV con productos que pertenecen a la misma familia (ej. todos los sabores de <strong>Electrolit 625</strong>). Cuando un SKU tiene una regla de familia asignada, la elasticidad se calcula a partir de las <strong>ventas agregadas de toda la familia</strong>, y el <strong>mismo precio final sugerido</strong> se aplica a todos los SKUs (porque no puedes tener dos sabores del mismo producto a precios distintos en la tienda). Los SKUs sin regla siguen calculándose de forma individual.
              </div>

              {/* Crear visualmente */}
              <div className="el-hero" style={{ background: "var(--el-hero)", color: "#fff", borderRadius: 22, padding: 18, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>✨ Crear regla visualmente</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.75)", lineHeight: 1.5 }}>
                    Abre un buscador interactivo para nombrar la familia y seleccionar los productos uno por uno.
                  </div>
                </div>
                <button onClick={() => setRuleBuilderOpen(true)} className="el-btn-pri" style={{
                  padding: "10px 20px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                }}>➕ Crear regla</button>
              </div>

              {/* Upload + descarga plantilla */}
              <div className="el-card" style={{ padding: 14, marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginBottom: 8 }}>...o definirlas de forma masiva con el layout</div>
                <ol className="el-steps">
                  <li><b>Descarga el layout</b>: trae tu catálogo (con los filtros de arriba) y las familias que ya existan.</li>
                  <li>Escribe el mismo nombre en <code>familia</code> para los productos que deben costar igual (ej. todos los sabores de <b>Electrolit 625 ml</b>).</li>
                  <li>Opcional: pon el precio en <code>precio_familia</code> para fijarlo. Si lo dejas vacío, la herramienta sugiere uno por elasticidad.</li>
                  <li><b>Sube el archivo</b>. Las filas sin familia se ignoran; también acepta <code>family,upc</code> o <code>family,sku</code>.</li>
                </ol>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <label className="el-btn-pri" style={{ padding: "8px 16px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                    Subir reglas
                    <input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => handleFamilyUpload(e.target.files?.[0])} />
                  </label>
                  <button onClick={() => {
                    // Layout con el catálogo real (respeta los filtros): se llenan "familia" y "precio_familia" y se sube de vuelta
                    const rows = [["familia", "sku", "upc", "descripcion", "departamento", "categoria", "marca", "precio_actual", "precio_familia",
                      "max_pct_change", "min_margin_pct", "max_margin_pct", "min_price_floor", "max_price_ceiling", "price_above_comp_min", "rounding_mode"]];
                    for (const p of filtered) {
                      const fam = familyRules[p.sku] || "";
                      const fr = (fam && familyBusinessRules[fam]) || {};
                      const lm = p.series[p.series.length - 1];
                      rows.push([fam, p.sku, p.upc || "", p.sku_des, p.department, p.category, p.brand, lm?.price?.toFixed(2) ?? "",
                        fam && isFinite(familyPrices[fam]) ? familyPrices[fam] : "",
                        fr.maxPctChange ?? "", fr.minMarginPct ?? "", fr.maxMarginPct ?? "", fr.minPriceFloor ?? "", fr.maxPriceCeiling ?? "", fr.priceAboveCompMin ?? "", fr.roundingMode ?? ""]);
                    }
                    downloadCSV(rows, "layout_familias.csv");
                  }} className="el-btn" style={{ padding: "8px 14px", fontSize: 12, cursor: "pointer" }}>
                    Descargar layout ({fmtInt(filtered.length)} productos)
                  </button>
                  {Object.keys(familyRules).length > 0 && (
                    <>
                      <button onClick={() => {
                        const rows = [["familia", "sku", "upc", "descripcion", "precio_familia", "max_pct_change", "min_margin_pct", "max_margin_pct", "min_price_floor", "max_price_ceiling", "price_above_comp_min", "rounding_mode"]];
                        for (const sku of Object.keys(familyRules)) {
                          const p = data.products.find(x => x.sku === sku);
                          const fam = familyRules[sku];
                          const fr = familyBusinessRules[fam] || {};
                          rows.push([
                            fam, sku, p?.upc || "", p?.sku_des || "", isFinite(familyPrices[fam]) ? familyPrices[fam] : "",
                            fr.maxPctChange ?? "", fr.minMarginPct ?? "", fr.maxMarginPct ?? "",
                            fr.minPriceFloor ?? "", fr.maxPriceCeiling ?? "", fr.priceAboveCompMin ?? "",
                            fr.roundingMode ?? "",
                          ]);
                        }
                        downloadCSV(rows, "reglas_familia_actual.csv");
                      }} style={{ padding: "8px 14px", borderRadius: 6, border: `1px solid ${C.green}`, background: "var(--db-pos-soft)", color: C.green, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                        Descargar reglas actuales
                      </button>
                      <button onClick={() => { setFamilyRules({}); setFamilyBusinessRules({}); setFamilyPrices({}); }} style={{ padding: "8px 14px", borderRadius: 6, border: `1px solid ${C.red}`, background: "var(--db-neg-soft)", color: C.red, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                        Eliminar todas las reglas
                      </button>
                    </>
                  )}
                </div>
                {familyUploadMsg && <div style={{ marginTop: 10, padding: 8, background: familyUploadMsg.startsWith("✓") ? "var(--db-pos-soft)" : "var(--db-neg-soft)", color: familyUploadMsg.startsWith("✓") ? C.green : C.red, borderRadius: 6, fontSize: 11 }}>{familyUploadMsg}</div>}
              </div>

              {/* Resumen */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                <StatCard label="Familias definidas" value={familyList.length} />
                <StatCard label="SKUs agrupados" value={Object.keys(familyRules).length} />
                <StatCard label="SKUs individuales" value={data.products.length - Object.keys(familyRules).length} />
              </div>

              {/* Lista de familias */}
              {familyList.length === 0 ? (
                <div style={{ background: C.card, border: `1px dashed ${C.border}`, borderRadius: 10, padding: 30, textAlign: "center", color: C.muted, fontSize: 13 }}>
                  No hay reglas de familia cargadas. Los cálculos se hacen a nivel SKU individual.
                </div>
              ) : (
                <div className="el-card" style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: "var(--db-track-bg)", borderBottom: `2px solid ${C.border}` }}>
                        {["Familia", "# SKUs", "Unidades (último mes)", "Precio hoy", "Precio familia", "Elasticidad Agregada", "Método", "MAPE", "SKUs", "Acciones"].map((h, i) => (
                          <th key={i} style={{ padding: "10px 8px", textAlign: i < 1 || i === 8 ? "left" : "center", color: C.sub, fontWeight: 600, fontSize: 9, textTransform: "uppercase" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {familyList.map((f, i) => {
                        const best = f.analysis?.best;
                        const fr = familyBusinessRules[f.name];
                        const frLabel = fr ? Object.entries(fr).map(([k, v]) => {
                          if (k === "maxPctChange") return `±${v}%`;
                          if (k === "minMarginPct") return `margen≥${v}%`;
                          if (k === "maxMarginPct") return `margen≤${v}%`;
                          if (k === "minPriceFloor") return `piso$${v}`;
                          if (k === "maxPriceCeiling") return `techo$${v}`;
                          if (k === "priceAboveCompMin") return `≤${v}%vComp`;
                          if (k === "roundingMode") return `→${v}`;
                          return "";
                        }).filter(Boolean).join(" · ") : null;
                        return (
                          <tr key={f.name} style={{ borderBottom: "1px solid var(--db-track-bg)", background: i % 2 ? "var(--db-track-bg)" : "transparent" }}>
                            <td style={{ padding: "10px 8px", fontWeight: 700, color: C.navy }}>
                              {f.name}
                              {frLabel && <div style={{ fontSize: 9, color: C.accent, marginTop: 2, fontWeight: 500 }}>🔧 {frLabel}</div>}
                            </td>
                            <td style={{ padding: "10px 8px", textAlign: "center", fontWeight: 600 }}>{f.skus.length}</td>
                            <td style={{ padding: "10px 8px", textAlign: "center" }}>{f.totalUnits.toLocaleString()}</td>
                            <td style={{ padding: "10px 8px", textAlign: "center", whiteSpace: "nowrap" }}>
                              {f.maxP - f.minP < 0.01 ? fmtPrice(f.minP) : <>{fmtPrice(f.minP)} – {fmtPrice(f.maxP)}<div><Badge color="amber">⚠ Precios distintos</Badge></div></>}
                            </td>
                            <td style={{ padding: "10px 8px", textAlign: "center" }}>
                              <input type="number" min="0" step="0.01" className="el-field" aria-label={`Precio fijo de la familia ${f.name}`}
                                style={{ width: 96, padding: "6px 8px", borderRadius: 6, fontSize: 12 }}
                                value={familyPrices[f.name] ?? ""}
                                placeholder={familySuggest[f.name] ? `Sug. ${familySuggest[f.name].finalPrice.toFixed(2)}` : "Automático"}
                                onChange={e => {
                                  const v = e.target.value === "" ? undefined : parseFloat(e.target.value);
                                  setFamilyPrices(r => { const n = { ...r }; if (isFinite(v) && v > 0) n[f.name] = v; else delete n[f.name]; return n; });
                                }}
                                onBlur={e => logAudit({ action: "FAMILY_PRICE", family: f.name, detail: e.target.value ? `Precio de familia ${f.name}: $${e.target.value}` : `Precio de familia ${f.name}: automático` })} />
                              <div style={{ fontSize: 9, color: C.muted, marginTop: 3 }}>{isFinite(familyPrices[f.name]) ? "Fijo (manual)" : "Vacío = sugerido por elasticidad"}</div>
                            </td>
                            <td style={{ padding: "10px 8px", textAlign: "center", fontWeight: 700, color: best ? (best.elasticity < -1 ? C.red : best.elasticity < 0 ? C.green : C.accent) : C.muted }}>
                              {best ? best.elasticity.toFixed(2) : "-"}
                            </td>
                            <td style={{ padding: "10px 8px", textAlign: "center" }}>{best ? <MethodBadge method={best.id} /> : "-"}</td>
                            <td style={{ padding: "10px 8px", textAlign: "center", fontSize: 10 }}>{best && best.mape !== null && best.mape < 999 ? best.mape.toFixed(1) + "%" : "-"}</td>
                            <td style={{ padding: "10px 8px", fontSize: 10, color: C.sub, maxWidth: 300 }}>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                                {f.products.slice(0, 8).map(p => (
                                  <span key={p.sku} title={p.sku_des} style={{ background: "var(--db-track-bg)", padding: "2px 6px", borderRadius: 4, fontSize: 9 }}>
                                    {p.sku}
                                  </span>
                                ))}
                                {f.products.length > 8 && <span style={{ fontSize: 9, color: C.muted }}>+{f.products.length - 8} más</span>}
                              </div>
                            </td>
                            <td style={{ padding: "10px 8px", textAlign: "center" }}>
                              <button onClick={() => {
                                const next = { ...familyRules };
                                for (const s of f.skus) delete next[s];
                                setFamilyRules(next);
                                setFamilyBusinessRules(r => { const n = { ...r }; delete n[f.name]; return n; });
                                setFamilyPrices(r => { const n = { ...r }; delete n[f.name]; return n; });
                              }} style={{ padding: "4px 10px", borderRadius: 5, border: `1px solid ${C.red}`, background: "var(--db-neg-soft)", color: C.red, fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
                                Eliminar
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              </>)}
            </div>
          );
        })()}

        {/* ── Configuración › Auditoría ── */}
        {tab === "admin" && adminSection === "audit" && (() => {
          // Por usuario: stats y serie de tiempo
          const byUser = {};
          for (const e of auditLog) {
            if (!byUser[e.user]) byUser[e.user] = { user: e.user, total: 0, approvals: 0, rejections: 0, bulk: 0, overrides: 0, rules: 0, scenarios: 0 };
            const b = byUser[e.user];
            b.total++;
            if (e.action === "APPROVE") b.approvals++;
            else if (e.action === "REJECT") b.rejections++;
            else if (e.action?.startsWith("BULK")) b.bulk++;
            else if (e.action === "OVERRIDE_PRICE") b.overrides++;
            else if (e.action?.includes("RULE")) b.rules++;
            else if (e.action === "SCENARIO_CHANGE") b.scenarios++;
          }
          const users = Object.values(byUser).sort((a, b) => b.total - a.total);

          // Serie por día (últimos 30 días)
          const byDay = {};
          for (const e of auditLog) {
            const d = (e.ts || "").slice(0, 10);
            if (!byDay[d]) byDay[d] = { date: d, events: 0, approvals: 0, rejections: 0 };
            byDay[d].events++;
            if (e.action === "APPROVE") byDay[d].approvals++;
            if (e.action === "REJECT") byDay[d].rejections++;
          }
          const timeline = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));

          const exportAuditCSV = () => {
            const rows = [["timestamp", "user", "action", "sku", "sku_des", "family", "before", "after", "detail"]];
            auditLog.forEach(e => rows.push([e.ts, e.user, e.action, e.sku || "", e.sku_des || "", e.family || "", e.before || "", e.after || "", e.detail || ""]));
            const csv = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
            const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url; a.download = "auditoria.csv"; a.click();
            URL.revokeObjectURL(url);
          };

          return (
            <div style={{ paddingBottom: 30 }}>
              <SectionHead ic="🔍">Auditoría de Decisiones</SectionHead>

              <div className="el-card" style={{ padding: 14, marginBottom: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>Usuario actual:</span>
                <input
                  type="text"
                  value={currentUser}
                  onChange={(e) => { setCurrentUser(e.target.value); try { localStorage.setItem("elasticity_user", e.target.value); } catch { /* almacenamiento no disponible */ } }}
                  className="el-field" style={{ padding: "7px 12px", borderRadius: 6, fontSize: 12, minWidth: 200 }}
                />
                <div style={{ flex: 1 }} />
                <button onClick={exportAuditCSV} disabled={auditLog.length === 0} className="el-btn-pri" style={{ padding: "7px 14px", fontSize: 11, fontWeight: 700, cursor: auditLog.length > 0 ? "pointer" : "not-allowed" }}>Exportar CSV</button>
                <button onClick={() => {
                  if (window.confirm("¿Limpiar todo el log de auditoría?")) setAuditLog([]);
                }} className="el-btn" style={{ padding: "7px 12px", color: C.red, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Limpiar log</button>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                <StatCard label="Eventos registrados" value={auditLog.length} accent />
                <StatCard label="Usuarios únicos" value={users.length} />
                <StatCard label="Aprobaciones" value={auditLog.filter(e => e.action === "APPROVE").length} />
                <StatCard label="Rechazos" value={auditLog.filter(e => e.action === "REJECT").length} />
                <StatCard label="Acciones masivas" value={auditLog.filter(e => e.action?.startsWith("BULK")).length} />
              </div>

              {auditLog.length === 0 ? (
                <div style={{ background: C.card, border: `1px dashed ${C.border}`, borderRadius: 10, padding: 40, textAlign: "center", color: C.muted }}>
                  No hay eventos registrados. Las acciones de aprobar/rechazar, cambios de escenario, overrides de precio y creación/eliminación de reglas se registrarán aquí automáticamente.
                </div>
              ) : (
                <>
                  {/* Timeline */}
                  {timeline.length > 1 && (
                    <>
                      <SectionHead ic="📅">Actividad por día</SectionHead>
                      <div className="el-card" style={{ padding: 16, marginBottom: 14 }}>
                        <ResponsiveContainer width="100%" height={220}>
                          <ComposedChart data={timeline} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--db-hair-2)" />
                            <XAxis dataKey="date" tick={{ fontSize: 9, fill: C.sub }} />
                            <YAxis tick={{ fontSize: 9, fill: C.sub }} />
                            <Tooltip content={<ChartTip />} />
                            <Legend wrapperStyle={{ fontSize: 10 }} />
                            <Bar dataKey="approvals" name="Aprobaciones" fill={C.green} />
                            <Bar dataKey="rejections" name="Rechazos" fill={C.red} />
                            <Line type="monotone" dataKey="events" name="Total eventos" stroke={C.blue} strokeWidth={2} dot={{ r: 3 }} />
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>
                    </>
                  )}

                  {/* Por usuario */}
                  <SectionHead ic="👥">Por Usuario</SectionHead>
                  <div className="el-card" style={{ padding: 16, marginBottom: 14 }}>
                    <ResponsiveContainer width="100%" height={Math.max(200, users.length * 40)}>
                      <BarChart data={users} layout="vertical" margin={{ top: 10, right: 10, left: 80, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--db-hair-2)" />
                        <XAxis type="number" tick={{ fontSize: 9, fill: C.sub }} />
                        <YAxis type="category" dataKey="user" tick={{ fontSize: 10, fill: C.sub }} width={80} />
                        <Tooltip content={<ChartTip />} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Bar dataKey="approvals" name="Aprobaciones" stackId="a" fill={C.green} />
                        <Bar dataKey="rejections" name="Rechazos" stackId="a" fill={C.red} />
                        <Bar dataKey="overrides" name="Overrides" stackId="a" fill={C.accent} />
                        <Bar dataKey="bulk" name="Masivas" stackId="a" fill={C.blue} />
                        <Bar dataKey="rules" name="Reglas" stackId="a" fill="var(--elc-5)" />
                        <Bar dataKey="scenarios" name="Escenarios" stackId="a" fill={C.mid} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="el-card" style={{ overflowX: "auto", marginBottom: 14 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr style={{ background: "var(--db-track-bg)", borderBottom: `2px solid ${C.border}` }}>
                          {["Usuario", "Total", "Aprobaciones", "Rechazos", "Overrides", "Masivas", "Reglas", "Escenarios"].map((h, i) => (
                            <th key={i} style={{ padding: "10px 8px", textAlign: i < 1 ? "left" : "center", fontSize: 9, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {users.map((u, i) => (
                          <tr key={u.user} style={{ borderBottom: "1px solid var(--db-track-bg)", background: i % 2 ? "var(--db-track-bg)" : "transparent" }}>
                            <td style={{ padding: "8px 8px", fontWeight: 600, color: C.navy }}>{u.user}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", fontWeight: 700 }}>{u.total}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: C.green }}>{u.approvals}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: C.red }}>{u.rejections}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: C.accent }}>{u.overrides}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: C.blue }}>{u.bulk}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: "var(--elc-5)" }}>{u.rules}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: C.mid }}>{u.scenarios}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Log detallado */}
                  <SectionHead ic="📜">Log Detallado (últimos 200)</SectionHead>
                  <div className="el-card" style={{ overflowX: "auto", maxHeight: 500, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr style={{ background: "var(--db-track-bg)", borderBottom: `2px solid ${C.border}`, position: "sticky", top: 0 }}>
                          {["Fecha/hora", "Usuario", "Acción", "SKU", "Detalle"].map((h, i) => (
                            <th key={i} style={{ padding: "10px 8px", textAlign: "left", fontSize: 9, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {auditLog.slice(0, 200).map((e, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid var(--db-track-bg)", background: i % 2 ? "var(--db-track-bg)" : "transparent" }}>
                            <td style={{ padding: "6px 8px", fontSize: 10, color: C.muted, whiteSpace: "nowrap" }}>{e.ts?.replace("T", " ").slice(0, 19)}</td>
                            <td style={{ padding: "6px 8px", fontSize: 10, color: C.navy, fontWeight: 600 }}>{e.user}</td>
                            <td style={{ padding: "6px 8px" }}>
                              <span style={{
                                padding: "2px 8px", borderRadius: 10, fontSize: 9, fontWeight: 700,
                                background: e.action === "APPROVE" ? "var(--db-pos-soft)" : e.action === "REJECT" ? "var(--db-neg-soft)" : e.action?.startsWith("BULK") ? "var(--db-accent-soft)" : "var(--db-accent-soft)",
                                color: e.action === "APPROVE" ? C.green : e.action === "REJECT" ? C.red : e.action?.startsWith("BULK") ? C.blue : "var(--elc-5)",
                              }}>{e.action}</span>
                            </td>
                            <td style={{ padding: "6px 8px", fontSize: 10, color: C.sub }}>{e.sku || "—"}</td>
                            <td style={{ padding: "6px 8px", fontSize: 10, color: C.text }}>{e.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          );
        })()}

        {/* ═══ GLOSSARY TAB ═══ */}
        {tab === "glossary" && (
          <div style={{ display: "grid", gap: 14, paddingBottom: 30 }}>
            <SectionHead ic="📚">Glosario y Mini Training de Elasticidad</SectionHead>

            <div className="el-card" style={{ padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>¿Qué es la elasticidad precio-demanda?</h3>
              <p style={{ fontSize: 12, color: C.sub, lineHeight: 1.7, margin: "8px 0 0" }}>
                Es una medida que indica <strong>cuánto cambia la cantidad demandada de un producto cuando cambia su precio</strong>. Matemáticamente es
                <code style={{ background: "var(--db-track-bg)", padding: "2px 8px", borderRadius: 4, margin: "0 4px" }}>E = (%ΔQ) / (%ΔP)</code>.
                Siempre se interpreta como un <strong>número negativo</strong> (cuando el precio sube, la cantidad baja). Entre más grande en valor absoluto, más sensible es la demanda al precio.
              </p>
            </div>

            <div className="el-card" style={{ padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>Cómo interpretar el valor</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10, marginTop: 10 }}>
                {[
                  { rango: "|E| < 0.2", titulo: "Perfectamente inelástica", color: C.green, desc: "La demanda prácticamente no reacciona al precio. Ejemplo: medicamentos críticos. Puedes subir precio con muy bajo riesgo.", accion: "Subir precio" },
                  { rango: "0.2 ≤ |E| < 1", titulo: "Inelástica", color: C.green, desc: "La demanda responde poco. Subir precio aumenta el ingreso total. Típico de productos con poca competencia o necesidad.", accion: "Subir precio moderado" },
                  { rango: "|E| = 1", titulo: "Elasticidad unitaria", color: C.accent, desc: "Un cambio % en precio provoca exactamente el mismo cambio % en demanda. El ingreso no cambia.", accion: "Mantener" },
                  { rango: "1 < |E| < 2", titulo: "Elástica", color: C.red, desc: "La demanda responde más que proporcionalmente. Bajar el precio aumenta el ingreso total.", accion: "Bajar precio" },
                  { rango: "|E| ≥ 2", titulo: "Muy elástica", color: C.red, desc: "Gran sensibilidad. Típico de commodities con muchos sustitutos. Ajusta con cuidado.", accion: "Bajar / ajustar fino" },
                  { rango: "E > 0", titulo: "Atípica (Giffen)", color: C.accent, desc: "Demanda sube cuando precio sube. Puede ser producto de prestigio, ruido estacional o serie con pocos datos.", accion: "Revisar datos" },
                ].map((row, i) => (
                  <div key={i} style={{ padding: 12, borderRadius: 8, background: "var(--db-track-bg)", borderLeft: `3px solid ${row.color}` }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: row.color, letterSpacing: 0.5 }}>{row.rango}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 2 }}>{row.titulo}</div>
                    <div style={{ fontSize: 11, color: C.sub, margin: "6px 0" }}>{row.desc}</div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: row.color }}>Acción sugerida: {row.accion}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="el-card" style={{ padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>Métodos de cálculo usados</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 10 }}>
                <div style={{ padding: 14, borderRadius: 8, background: "var(--db-track-bg)", borderTop: `3px solid ${METHOD_COLORS.ols}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: METHOD_COLORS.ols }}>OLS Lineal</div>
                  <div style={{ fontSize: 11, color: C.sub, margin: "6px 0" }}>Modelo: <code>Q = a + b·P</code>. La elasticidad se deriva como <code>E = b × (P̄/Q̄)</code>.</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 8 }}><strong>Cuándo usarlo:</strong> cuando la relación precio-demanda se ve aproximadamente lineal en el gráfico. Útil cuando los precios cambian poco.</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 4 }}><strong>Limitación:</strong> la elasticidad depende del nivel de precio y cantidad promedio; no captura cambios porcentuales grandes.</div>
                </div>
                <div style={{ padding: 14, borderRadius: 8, background: "var(--db-accent-soft)", borderTop: `3px solid ${METHOD_COLORS.loglog}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: METHOD_COLORS.loglog }}>Log-Log</div>
                  <div style={{ fontSize: 11, color: C.sub, margin: "6px 0" }}>Modelo: <code>ln(Q) = a + b·ln(P)</code>. El coeficiente <code>b</code> ES directamente la elasticidad.</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 8 }}><strong>Cuándo usarlo:</strong> es el método más robusto para la mayoría de productos. Asume elasticidad constante, lo que suele ajustarse bien a datos reales.</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 4 }}><strong>Limitación:</strong> requiere precios y unidades positivas (no cero).</div>
                </div>
                <div style={{ padding: 14, borderRadius: 8, background: "var(--db-warn-soft)", borderTop: `3px solid ${METHOD_COLORS.arc}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: METHOD_COLORS.arc }}>Arco Mid-Point</div>
                  <div style={{ fontSize: 11, color: C.sub, margin: "6px 0" }}>Calcula <code>E = (ΔQ/ΔP) × ((P₁+P₂)/(Q₁+Q₂))</code> entre cada par consecutivo y promedia.</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 8 }}><strong>Cuándo usarlo:</strong> cuando hay pocos datos históricos o cuando ocurren <strong>cambios grandes y puntuales</strong> de precio (ej. promociones).</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 4 }}><strong>Limitación:</strong> sensible a outliers; si dos meses tienen el mismo precio, ese par no aporta.</div>
                </div>
              </div>
            </div>

            <div className="el-card" style={{ padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>Métricas de error</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, marginTop: 10 }}>
                {[
                  { k: "MAPE", n: "Mean Absolute Percentage Error", d: "Promedio del error porcentual absoluto entre predicción y realidad. Es el criterio principal para elegir el mejor método. <30% = excelente, 30-60% = aceptable, >60% = débil." },
                  { k: "RMSE", n: "Root Mean Squared Error", d: "Raíz del error cuadrático medio. Penaliza más los errores grandes. Útil para comparar entre métodos pero difícil de interpretar en términos absolutos." },
                  { k: "MAE", n: "Mean Absolute Error", d: "Error absoluto medio (en unidades). Fácil de interpretar: en promedio la predicción se desvía X unidades." },
                  { k: "R²", n: "Coeficiente de determinación", d: "% de la varianza de la demanda que explica el modelo. 1.0 es perfecto, 0 es igual a usar el promedio. Sólo se calcula para OLS y Log-Log." },
                ].map((m, i) => (
                  <div key={i} style={{ padding: 12, borderRadius: 8, background: "var(--db-track-bg)" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.navy }}>{m.k} <span style={{ fontSize: 10, fontWeight: 400, color: C.sub }}>— {m.n}</span></div>
                    <div style={{ fontSize: 11, color: C.sub, marginTop: 4, lineHeight: 1.5 }}>{m.d}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="el-card" style={{ padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>Fórmulas de precio óptimo</h3>
              <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.7, marginTop: 8 }}>
                <p><strong>{"Caso elástico (|E| > 1):"}</strong> el precio que maximiza el ingreso es <code style={{ background: "var(--db-track-bg)", padding: "2px 6px", borderRadius: 4 }}>P* = P_actual / (1 + 1/E)</code>. Esta es la condición de Lerner.</p>
                <p><strong>{"Caso inelástico (|E| ≤ 1):"}</strong> matemáticamente el ingreso sigue creciendo con cualquier subida, así que la práctica común es sugerir subidas moderadas (5%) y cuidar no exceder precios de referencia.</p>
                <p><strong>Restricciones aplicadas:</strong> el sugerido se acota a ±30% del precio actual y a un mínimo del costo × 1.02 (si hay dato de margen).</p>
              </div>
            </div>

            <div style={{ background: "var(--db-pos-soft)", border: `1px solid var(--el-pos-line)`, borderLeft: `4px solid ${C.green}`, borderRadius: 12, padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>⚙️ Cómo trabaja el optimizador de este dashboard</h3>
              <div style={{ fontSize: 11, color: C.text, lineHeight: 1.7, marginTop: 8 }}>
                <p>
                  <strong>Búsqueda numérica del óptimo:</strong> el optimizador busca numéricamente dentro del rango ±30% el precio que maximiza
                  <code style={{ background: "var(--db-pos-soft)", padding: "2px 6px", borderRadius: 4, margin: "0 4px" }}>P·Q(P)</code>
                  bajo
                  <code style={{ background: "var(--db-pos-soft)", padding: "2px 6px", borderRadius: 4, margin: "0 4px" }}>Q = Q₀·(P/P₀)^E</code>.
                  Esto <strong>garantiza que el ingreso proyectado sea siempre ≥ el actual</strong>.
                </p>
                <p>
                  <strong>Elasticidad atípica (E ≥ 0, Giffen):</strong> se trata como <em>"sin señal"</em> y el modelo mantiene el precio actual en lugar de recomendar un cambio basado en una elasticidad positiva espuria.
                </p>
                <p>
                  <strong>Límite de predicción:</strong> el volumen proyectado nunca sube/baja más de <strong>5×</strong> respecto al actual, evitando proyecciones infinitas causadas por outliers en la elasticidad calculada (|E| extremas por series cortas o ruido).
                </p>
                <p style={{ marginBottom: 0, fontSize: 10, color: C.sub, fontStyle: "italic" }}>
                  Adicionalmente, las elasticidades con |E| &gt; 4 se capean a -4 en los cálculos de proyección, ya que valores más extremos casi siempre reflejan ruido y no comportamiento real de mercado.
                </p>
              </div>
            </div>

            <div className="el-card" style={{ padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>Comparativa rápida: cuándo elegir cada método</h3>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginTop: 10 }}>
                <thead>
                  <tr style={{ background: "var(--db-track-bg)" }}>
                    <th style={{ textAlign: "left", padding: 8, color: C.sub, fontSize: 10 }}>Situación del producto</th>
                    <th style={{ textAlign: "left", padding: 8, color: C.sub, fontSize: 10 }}>Mejor método</th>
                    <th style={{ textAlign: "left", padding: 8, color: C.sub, fontSize: 10 }}>Por qué</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Demanda estable, precio con variaciones pequeñas", "OLS Lineal", "Relación aproximadamente lineal; pocos datos bastan."],
                    ["Serie larga, comportamiento típico de retail", "Log-Log", "Captura elasticidad constante; robusto a escala."],
                    ["Promociones grandes / pocos puntos / cambios abruptos", "Arco Mid-Point", "No asume forma funcional; cada par aporta su propia elasticidad."],
                    ["Producto nuevo con poca historia", "Arco + validar con categoría", "Con 3-6 meses Log-Log se vuelve inestable."],
                    ["KVI (Key Value Item) muy sensible a competencia", "Log-Log + precio de competencia", "Elasticidad constante + benchmark externo."],
                  ].map((row, i) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--db-track-bg)" }}>
                      <td style={{ padding: 8, color: C.text }}>{row[0]}</td>
                      <td style={{ padding: 8, color: C.navy, fontWeight: 700 }}>{row[1]}</td>
                      <td style={{ padding: 8, color: C.sub }}>{row[2]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ background: "var(--db-accent-soft)", border: `1px solid var(--el-info-line)`, borderRadius: 12, padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>💡 Tips prácticos</h3>
              <ul style={{ fontSize: 11, color: C.sub, lineHeight: 1.8, marginTop: 6, paddingLeft: 18 }}>
                <li>Si el <strong>MAPE &gt; 60%</strong> en los 3 métodos, considera que los datos tienen demasiado ruido para una recomendación confiable.</li>
                <li>Siempre valida la sugerencia contra el <strong>precio de la competencia</strong> antes de ejecutar cambios en el mercado.</li>
                <li>Productos <strong>KVI</strong> (Key Value Items) necesitan un análisis más conservador: aunque la elasticidad sugiera subir, los clientes los usan como referencia para comparar.</li>
                <li>Un R² alto <strong>no</strong> garantiza que el método sea el mejor — siempre revisa también el MAPE.</li>
              </ul>
            </div>
          </div>
        )}

        <div style={{ textAlign: "center", padding: "20px 0 30px", fontSize: 10, color: C.muted }}>
          Data Bunker | www.data-bunker.ai | Price Elasticity Engine
        </div>
      </div>

      {/* ═══ CLUSTER DETAIL POPUP (inline sortable) ═══ */}
      {clusterPopup && <ClusterPopup
        clusterPopup={clusterPopup}
        onClose={() => setClusterPopup(null)}
        onSelectSku={(sku) => { setDetailSku(sku); setClusterPopup(null); }}
      />}
      {/* ═══ PRODUCT DETAIL POPUP (análisis de elasticidad de un SKU) ═══ */}
      {detailSku && (() => {
        const prod = data.products.find(p => p.sku === detailSku);
        if (!prod) return null;
        const fam = familyRules[detailSku] || null;
        return <ProductDetailModal
          product={prod}
          analysis={allAnalysis[detailSku]}
          compData={compBySku[detailSku]}
          familyName={fam}
          familyMemberCount={fam ? (familyAggregates[fam]?.skus?.length || 0) : 0}
          onClose={() => setDetailSku(null)}
        />;
      })()}
      {/* ═══ RULE BUILDER POPUP ═══ */}
      {ruleBuilderOpen && <RuleBuilder
        allProducts={data.products}
        existingRules={familyRules}
        compBySku={compBySku}
        onClose={() => setRuleBuilderOpen(false)}
        onSave={(familyName, skus, customRules) => {
          const next = { ...familyRules };
          for (const s of skus) next[s] = familyName;
          setFamilyRules(next);
          if (customRules && Object.keys(customRules).length > 0) {
            setFamilyBusinessRules(r => ({ ...r, [familyName]: customRules }));
          }
          setRuleBuilderOpen(false);
          logAudit({
            action: "RULE_FAMILY_CREATE",
            family: familyName,
            detail: `Familia "${familyName}" creada con ${skus.length} SKUs${customRules && Object.keys(customRules).length > 0 ? " + reglas específicas" : ""}`,
          });
        }}
      />}
    </>
  );
}

// ═══ Product Detail Modal (análisis de elasticidad de un SKU, en popup) ═══
function ProductDetailModal({ product, analysis, compData, familyName, familyMemberCount, onClose }) {
  const [selMethod, setSelMethod] = useState(null);

  const activeMethod = useMemo(() => {
    if (!analysis?.results?.length) return null;
    if (selMethod) return analysis.results.find(r => r.id === selMethod) || analysis.best;
    return analysis.best;
  }, [analysis, selMethod]);

  const chartData = useMemo(() => {
    if (!product) return [];
    const results = analysis?.results || [];

    if (familyName || results.some(r => !r.predicted)) {
      // El análisis viene AGREGADO (familia o departamento): sus arreglos `predicted` están en
      // otra escala o no existen. Reconstruimos la predicción
      // por método a la escala del SKU con elasticidad constante alrededor de su media:
      //   Q_pred(P) = Q̄_sku · (P/P̄_sku)^E_método
      const valid = product.series.filter(d => d.price > 0 && d.units > 0);
      const pMean = valid.length ? valid.reduce((s, d) => s + d.price, 0) / valid.length : 0;
      const qMean = valid.length ? valid.reduce((s, d) => s + d.units, 0) / valid.length : 0;
      return product.series.map(d => {
        const row = { month: d.month, precio: d.price, unidades: d.units };
        if (d.price > 0 && d.units > 0 && pMean > 0 && qMean > 0) {
          results.forEach(r => {
            const pred = qMean * Math.pow(d.price / pMean, r.elasticity);
            if (isFinite(pred) && pred >= 0) row[r.id + "_pred"] = Math.round(pred);
          });
        }
        return row;
      });
    }

    // Análisis propio del SKU: cada `predicted` corresponde a los puntos VÁLIDOS
    // (precio>0 y unidades>0) en orden, no a la serie completa. Alineamos con un
    // contador de puntos válidos para no desfasarnos si hay meses inválidos.
    let vi = 0;
    return product.series.map(d => {
      const row = { month: d.month, precio: d.price, unidades: d.units };
      if (d.price > 0 && d.units > 0) {
        results.forEach(r => {
          if (r.predicted && r.predicted[vi] !== undefined) row[r.id + "_pred"] = Math.round(r.predicted[vi]);
        });
        vi++;
      }
      return row;
    });
  }, [product, analysis, familyName]);

  const scatterData = useMemo(() => {
    if (!product) return [];
    return product.series.filter(d => d.price > 0 && d.units > 0).map(d => ({ price: d.price, units: d.units }));
  }, [product]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasAnalysis = analysis?.results?.length > 0;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--db-scrim)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "24px 16px", overflowY: "auto" }}>
      <div onClick={e => e.stopPropagation()} className="el-modal" style={{ maxWidth: 1000, width: "100%", padding: "18px 20px 24px", position: "relative" }}>
        <button onClick={onClose} title="Cerrar (Esc)" style={{ position: "absolute", top: 12, right: 12, zIndex: 3, width: 30, height: 30, borderRadius: 8, border: "none", background: "var(--db-scrim)", color: "#fff", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        {!hasAnalysis ? (
          <div style={{ textAlign: "center", padding: 60, color: C.sub }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📊</div>
            <div style={{ fontSize: 14 }}>No hay suficiente información para calcular la elasticidad de este producto.</div>
            {analysis?.segment && (
              <div style={{ fontSize: 12, marginTop: 10, maxWidth: 560, marginInline: "auto", lineHeight: 1.5 }}>
                {analysis.segment.reliable ? (
                  <>Su departamento, <strong>{analysis.segment.name}</strong>, sí responde al precio (E={analysis.segment.elasticity.toFixed(2)}), pero la historia propia de este SKU no muestra esa sensibilidad,
                    así que se recomienda <strong>mantener el precio</strong>.</>
                ) : (
                  <>En <strong>{analysis.segment.name}</strong> la elasticidad estimada es {analysis.segment.elasticity.toFixed(2)} (±{analysis.segment.se}, t={analysis.segment.t}, {analysis.segment.n} SKUs):
                    no es estadísticamente distinta de cero o tiene el signo equivocado, y este SKU tampoco muestra señal propia, así que se recomienda <strong>mantener el precio</strong>.</>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Product header */}
            {(() => {
              const selComp = compData;
              const interp = activeMethod ? interpretElasticity(activeMethod.elasticity) : null;
              return (
                <div className="el-hero" style={{ background: "var(--el-hero)", borderRadius: 22, padding: 18, marginBottom: 14, display: "flex", gap: 16 }}>
                  <div style={{ width: 110, height: 110, flexShrink: 0, background: "rgba(255,255,255,0.08)", borderRadius: 10, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(255,255,255,0.1)" }}>
                    {selComp?.image ? (
                      <img src={selComp.image} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", background: "var(--db-surface-hi)" }} onError={e => { e.target.style.display = "none"; }} />
                    ) : (
                      <span style={{ fontSize: 40 }}>📦</span>
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{product.sku_des}</div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", marginTop: 2 }}>
                      SKU: {product.sku} | UPC: {product.upc || "N/D"} | {product.department} | {product.category} | {product.brand}
                    </div>
                    {familyName && (
                      <div style={{ marginTop: 4, display: "inline-block", background: "var(--db-warn-soft)", color: C.accent, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>
                        👪 Familia: {familyName} · elasticidad agregada de {familyMemberCount} SKUs
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
                      <div><div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)" }}>PRECIO PROM</div><div style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>${product.avgPrice.toLocaleString("es-MX")}</div></div>
                      <div><div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)" }}>UNIDADES TOTAL</div><div style={{ fontSize: 18, fontWeight: 700, color: C.light }}>{product.totalUnits.toLocaleString()}</div></div>
                      <div><div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)" }}>MESES</div><div style={{ fontSize: 18, fontWeight: 700, color: C.accent }}>{product.series.length}</div></div>
                      {activeMethod && (
                        <div>
                          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)" }}>ELASTICIDAD</div>
                          <div style={{ fontSize: 22, fontWeight: 800, color: activeMethod.elasticity < -1 ? C.red : activeMethod.elasticity < 0 ? C.green : C.accent }}>{activeMethod.elasticity.toFixed(3)}</div>
                          {interp && (
                            <div style={{ fontSize: 10, fontWeight: 700, color: C.accent, marginTop: 2 }}>
                              {interp.label}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {interp && (
                      <div style={{ marginTop: 10, padding: "8px 10px", background: "rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 10, color: "rgba(255,255,255,0.85)", lineHeight: 1.5 }}>
                        <strong style={{ color: C.accent }}>¿Qué significa?</strong> {interp.explanation}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Method selector */}
            <SectionHead ic="🔬">Seleccionar Metodologia</SectionHead>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
              <button onClick={() => setSelMethod(null)} style={{
                padding: "8px 14px", borderRadius: 8, border: selMethod === null ? `2px solid ${C.green}` : `1px solid ${C.border}`,
                background: selMethod === null ? "var(--db-pos-soft)" : C.card, cursor: "pointer", fontSize: 11, fontWeight: 600,
                color: selMethod === null ? C.green : C.sub,
              }}>
                Auto (Mejor) {analysis.best && <span style={{ fontSize: 9, marginLeft: 4 }}>= {analysis.best.method}</span>}
              </button>
              {analysis.results.map(r => (
                <button key={r.id} onClick={() => setSelMethod(r.id)} style={{
                  padding: "8px 14px", borderRadius: 8,
                  border: selMethod === r.id ? `2px solid ${METHOD_COLORS[r.id]}` : `1px solid ${C.border}`,
                  background: selMethod === r.id ? `${METHOD_COLORS[r.id]}11` : C.card,
                  cursor: "pointer", fontSize: 11, fontWeight: 600,
                  color: selMethod === r.id ? METHOD_COLORS[r.id] : C.sub,
                }}>
                  {r.method} <span style={{ fontSize: 9, marginLeft: 4 }}>(E={r.elasticity.toFixed(2)})</span>
                </button>
              ))}
            </div>

            {/* Method metrics */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 16 }}>
              {analysis.results.map(r => {
                const isBest = analysis.best?.id === r.id;
                const isActive = activeMethod?.id === r.id;
                return (
                  <div key={r.id} style={{
                    background: C.card, borderRadius: 10, padding: 14,
                    border: isActive ? `2px solid ${METHOD_COLORS[r.id]}` : `1px solid ${C.border}`,
                    boxShadow: isActive ? `0 2px 12px ${METHOD_COLORS[r.id]}22` : "none",
                    position: "relative",
                  }}>
                    {isBest && (
                      <div style={{ position: "absolute", top: -8, right: 10, background: C.green, color: "var(--db-ink-inverse)", fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>
                        RECOMENDADO
                      </div>
                    )}
                    <div style={{ fontSize: 12, fontWeight: 700, color: METHOD_COLORS[r.id], marginBottom: 8 }}>{r.method}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 11 }}>
                      <div><span style={{ color: C.sub }}>Elasticidad:</span></div>
                      <div style={{ fontWeight: 700, textAlign: "right" }}>{r.elasticity.toFixed(3)}</div>
                      {r.r2 !== null && <><div><span style={{ color: C.sub }}>R²:</span></div><div style={{ fontWeight: 600, textAlign: "right" }}>{r.r2.toFixed(4)}</div></>}
                      {r.mape !== null && <>
                        <div><span style={{ color: C.sub }}>RMSE:</span></div>
                        <div style={{ fontWeight: 600, textAlign: "right" }}>{r.rmse.toLocaleString()}</div>
                        <div><span style={{ color: C.sub }}>MAE:</span></div>
                        <div style={{ fontWeight: 600, textAlign: "right" }}>{r.mae.toLocaleString()}</div>
                        <div><span style={{ color: C.sub }}>MAPE:</span></div>
                        <div style={{ fontWeight: 600, textAlign: "right", color: r.mape < 30 ? C.green : r.mape < 60 ? C.accent : C.red }}>{r.mape < 999 ? r.mape.toFixed(1) + "%" : "N/A"}</div>
                      </>}
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 6 }}>{r.description}</div>
                  </div>
                );
              })}
            </div>

            {/* Price suggestion */}
            {activeMethod && (() => {
              const lastMonth = product.series[product.series.length - 1];
              const sug = suggestPrice(lastMonth.price, activeMethod.elasticity, lastMonth.margin);
              const selComp = compData;
              const note = priceChangeNote(sug.pctChange, activeMethod.elasticity, lastMonth.price, lastMonth.margin, selComp?.minPrice);
              return (
                <>
                  <div className="el-hero" style={{ background: "var(--el-hero-pos)", borderRadius: 22, padding: 18, display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", marginBottom: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", fontWeight: 600 }}>Precio Sugerido ({activeMethod.method})</div>
                      <div style={{ fontSize: 30, fontWeight: 800, color: "#fff" }}>${sug.suggestedPrice.toLocaleString("es-MX")}</div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.8)", marginTop: 2 }}>{sug.reason}</div>
                    </div>
                    <div style={{ display: "flex", gap: 18 }}>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)" }}>ACTUAL</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>${lastMonth.price.toLocaleString("es-MX")}</div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)" }}>CAMBIO</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: sug.pctChange > 0 ? C.green : C.red }}>
                          {sug.pctChange > 0 ? "+" : ""}{sug.pctChange}%
                        </div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)" }}>TIPO</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.accent }}>
                          {Math.abs(activeMethod.elasticity) > 1 ? "Elastico" : "Inelastico"}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Reasoning note */}
                  <div style={{ background: "var(--db-warn-soft)", border: "1px solid var(--el-warn-line)", borderLeft: `4px solid ${C.accent}`, borderRadius: 8, padding: "12px 14px", marginBottom: 14, fontSize: 11, color: C.text, lineHeight: 1.55 }}>
                    <div style={{ fontWeight: 700, color: C.navy, marginBottom: 4, fontSize: 11 }}>
                      {sug.pctChange > 0.5 ? "⬆️ Razón para subir:" : sug.pctChange < -0.5 ? "⬇️ Razón para bajar:" : "➡️ Razón para mantener:"}
                    </div>
                    {note}
                  </div>

                  {/* Competitor prices */}
                  {selComp && selComp.competitors?.length > 0 && (
                    <div className="el-card" style={{ padding: 14, marginBottom: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.navy }}>🏪 Precios de la Competencia</div>
                        <div style={{ fontSize: 10, color: C.sub }}>UPC: {selComp.upc}</div>
                      </div>
                      <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                        <div style={{ padding: "6px 10px", background: "var(--db-pos-soft)", borderRadius: 6, fontSize: 11 }}>
                          <span style={{ color: C.sub }}>Mín: </span><strong style={{ color: C.green }}>${selComp.minPrice?.toLocaleString("es-MX")}</strong>
                        </div>
                        <div style={{ padding: "6px 10px", background: "var(--db-accent-soft)", borderRadius: 6, fontSize: 11 }}>
                          <span style={{ color: C.sub }}>Prom: </span><strong style={{ color: C.blue }}>${selComp.avgPrice?.toLocaleString("es-MX")}</strong>
                        </div>
                        <div style={{ padding: "6px 10px", background: "var(--db-neg-soft)", borderRadius: 6, fontSize: 11 }}>
                          <span style={{ color: C.sub }}>Máx: </span><strong style={{ color: C.red }}>${selComp.maxPrice?.toLocaleString("es-MX")}</strong>
                        </div>
                        <div style={{ padding: "6px 10px", background: "var(--db-warn-soft)", borderRadius: 6, fontSize: 11 }}>
                          <span style={{ color: C.sub }}>Tu precio: </span><strong style={{ color: C.accent }}>${lastMonth.price.toLocaleString("es-MX")}</strong>
                        </div>
                        <div style={{ padding: "6px 10px", background: "var(--db-accent-soft)", borderRadius: 6, fontSize: 11 }}>
                          <span style={{ color: C.sub }}>Sugerido vs Mín: </span>
                          <strong style={{ color: sug.suggestedPrice > selComp.minPrice ? C.red : C.green }}>
                            {(((sug.suggestedPrice - selComp.minPrice) / selComp.minPrice) * 100).toFixed(1)}%
                          </strong>
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px,1fr))", gap: 6 }}>
                        {selComp.competitors.slice(0, 12).map((c, i) => (
                          <div key={i} style={{ padding: "6px 8px", background: "var(--db-track-bg)", borderRadius: 6, fontSize: 10, display: "flex", justifyContent: "space-between", gap: 6 }}>
                            <span style={{ color: C.sub, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{c.canal}</span>
                            <strong style={{ color: C.navy, flexShrink: 0 }}>${c.price.toLocaleString("es-MX")}</strong>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}

            {/* Charts: último 6m + forecast 6m */}
            {(() => {
              const lastMonth = product.series[product.series.length - 1];
              const sug = activeMethod ? suggestPrice(lastMonth.price, activeMethod.elasticity, lastMonth.margin) : null;
              const elastS = sanitizeElasticity(activeMethod?.elasticity ?? 0);
              const last6 = product.series.slice(-6);
              const avgUnitsLast6 = last6.length > 0 ? last6.reduce((s, d) => s + d.units, 0) / last6.length : 0;
              const history = last6.map(d => ({
                month: d.month,
                precio: d.price,
                unidadesHist: d.units,
                unidadesF: null,
                venta: Math.round(d.price * d.units),
                tipo: "histórico",
              }));
              const forecast = [];
              if (lastMonth && sug) {
                const parseYm = (ym) => {
                  const [y, m] = ym.split("-").map(Number);
                  return { y, m };
                };
                const { y: ly, m: lm } = parseYm(lastMonth.month);
                for (let i = 1; i <= 6; i++) {
                  const newM = lm + i;
                  const y = ly + Math.floor((newM - 1) / 12);
                  const m = ((newM - 1) % 12) + 1;
                  const t = Math.min(1, i / 3);
                  const price = lastMonth.price + (sug.suggestedPrice - lastMonth.price) * t;
                  const elastFactor = lastMonth.price > 0 ? Math.pow(price / lastMonth.price, elastS) : 1;
                  const units = Math.max(0, avgUnitsLast6 * elastFactor);
                  forecast.push({
                    month: `${y}-${String(m).padStart(2, "0")}`,
                    precio: null,
                    precioF: Math.round(price * 100) / 100,
                    unidadesHist: null,
                    unidadesF: Math.round(units),
                    venta: Math.round(price * units),
                    tipo: "forecast",
                  });
                }
              }
              const combo = [...history, ...forecast];
              const totalHistRev = history.reduce((s, h) => s + h.venta, 0);
              const totalFcstRev = forecast.reduce((s, h) => s + h.venta, 0);
              return (
                <>
                  <SectionHead ic="📈">Precio, Demanda y Forecast (últimos 6 + siguientes 6 meses)</SectionHead>
                  <div className="el-card" style={{ padding: 16, marginBottom: 14 }}>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10, fontSize: 11 }}>
                      <div style={{ padding: "6px 10px", background: "var(--db-accent-soft)", borderRadius: 6 }}>
                        <span style={{ color: C.sub }}>Venta histórica 6m: </span><strong style={{ color: C.blue }}>${totalHistRev.toLocaleString("es-MX")}</strong>
                      </div>
                      <div style={{ padding: "6px 10px", background: "var(--db-pos-soft)", borderRadius: 6 }}>
                        <span style={{ color: C.sub }}>Venta forecast 6m: </span><strong style={{ color: C.green }}>${totalFcstRev.toLocaleString("es-MX")}</strong>
                      </div>
                      {sug && (
                        <div style={{ padding: "6px 10px", background: "var(--db-warn-soft)", borderRadius: 6 }}>
                          <span style={{ color: C.sub }}>Precio objetivo forecast: </span><strong style={{ color: C.accent }}>${sug.suggestedPrice}</strong>
                          {" "}(desde ${lastMonth.price})
                        </div>
                      )}
                    </div>
                    <ResponsiveContainer width="100%" height={280}>
                      <ComposedChart data={combo} margin={{ top: 10, right: 10, left: -5, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--db-hair-2)" />
                        <XAxis dataKey="month" tick={{ fontSize: 9, fill: C.sub }} />
                        <YAxis yAxisId="left" tick={{ fontSize: 9, fill: C.sub }} tickFormatter={v => "$" + v.toLocaleString()} />
                        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9, fill: C.sub }} />
                        <Tooltip content={<ChartTip />} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Bar yAxisId="right" dataKey="unidadesHist" name="Unidades (hist.)" fill={C.mid} opacity={0.35} radius={[2, 2, 0, 0]} />
                        <Bar yAxisId="right" dataKey="unidadesF" name="Unidades (forecast ≈ prom. 6m × elasticidad)" fill={C.accent} fillOpacity={0.35} stroke={C.accent} radius={[2, 2, 0, 0]} />
                        <Line yAxisId="left" type="monotone" dataKey="precio" name="Precio (hist.)" stroke={C.blue} strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} />
                        <Line yAxisId="left" type="monotone" dataKey="precioF" name="Precio (forecast)" stroke={C.accent} strokeWidth={2.5} strokeDasharray="5 3" dot={{ r: 3 }} connectNulls={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>

                  {/* What-if scenario chart con modelo lineal local (muestra sweet spot) */}
                  {activeMethod && lastMonth && (() => {
                    const P0 = lastMonth.price;
                    const Q0 = lastMonth.units;
                    const E = elastS;
                    const slope = E * Q0 / P0;
                    const demandAt = (p) => Math.max(0, Q0 + slope * (p - P0));

                    let sweet = P0;
                    if (E < 0) {
                      const pChoke = P0 * (1 - 1 / E);
                      sweet = pChoke / 2;
                      if (sweet < P0 * 0.5) sweet = P0 * 0.5;
                      if (sweet > P0 * 1.5) sweet = P0 * 1.5;
                    }
                    const scenarios = [];
                    for (let pct = -50; pct <= 50; pct += 5) {
                      const p = P0 * (1 + pct / 100);
                      const u = demandAt(p);
                      const rev = p * u;
                      scenarios.push({
                        pct,
                        price: Math.round(p * 100) / 100,
                        units: Math.round(u),
                        revenue: Math.round(rev),
                        label: (pct > 0 ? "+" : "") + pct + "%",
                      });
                    }
                    const currentRev = P0 * Q0;
                    const sweetUnits = demandAt(sweet);
                    const sweetRev = sweet * sweetUnits;
                    const sweetPct = ((sweet - P0) / P0) * 100;
                    const sugRev = sug ? sug.suggestedPrice * demandAt(sug.suggestedPrice) : currentRev;

                    return (
                      <>
                        <SectionHead ic="🎲">Análisis What-If (sweet spot de maximización de ingreso)</SectionHead>
                        <div className="el-card" style={{ padding: 16, marginBottom: 14 }}>
                          <div style={{ fontSize: 11, color: C.sub, marginBottom: 10, lineHeight: 1.5 }}>
                            La curva usa un <strong>modelo lineal local</strong> calibrado al precio y unidades actuales y a la elasticidad estimada. Este modelo captura la intuición de que si bajas demasiado el precio, aunque vendas más unidades, el <strong>ingreso total cae</strong> porque el precio unitario se reduce más rápido de lo que crece el volumen. La línea <span style={{ color: C.accent, fontWeight: 700 }}>⭐ sweet spot</span> marca el precio donde la <em>venta total ($)</em> es máxima.
                          </div>
                          <ResponsiveContainer width="100%" height={280}>
                            <ComposedChart data={scenarios} margin={{ top: 10, right: 10, left: -5, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--db-hair-2)" />
                              <XAxis dataKey="label" tick={{ fontSize: 10, fill: C.sub }} label={{ value: "Cambio de precio vs actual", position: "insideBottom", offset: -5, fontSize: 10, fill: C.sub }} />
                              <YAxis tick={{ fontSize: 9, fill: C.sub }} tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} />
                              <Tooltip content={<ChartTip />} />
                              <Legend wrapperStyle={{ fontSize: 10 }} />
                              <Area type="monotone" dataKey="revenue" name="Venta proyectada ($)" fill={C.light} stroke={C.blue} strokeWidth={2} fillOpacity={0.25} />
                              <Line type="monotone" dataKey="units" name="Unidades vendidas" stroke={C.green} strokeWidth={1.5} strokeDasharray="3 3" dot={false} yAxisId="left" />
                            </ComposedChart>
                          </ResponsiveContainer>

                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginTop: 14 }}>
                            <div style={{ padding: 10, borderRadius: 8, background: "var(--db-accent-soft)", borderLeft: `3px solid ${C.blue}` }}>
                              <div style={{ fontSize: 9, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>Precio actual (0%)</div>
                              <div style={{ fontSize: 14, fontWeight: 700, color: C.blue }}>${P0} → ${Math.round(currentRev).toLocaleString()}</div>
                            </div>
                            <div style={{ padding: 10, borderRadius: 8, background: "var(--db-warn-soft)", borderLeft: `3px solid ${C.accent}` }}>
                              <div style={{ fontSize: 9, color: C.accent, fontWeight: 700, textTransform: "uppercase" }}>⭐ Sweet spot (máx. ingreso)</div>
                              <div style={{ fontSize: 14, fontWeight: 700, color: C.accent }}>${sweet.toFixed(2)} ({sweetPct > 0 ? "+" : ""}{sweetPct.toFixed(1)}%) → ${Math.round(sweetRev).toLocaleString()}</div>
                            </div>
                            {sug && (
                              <div style={{ padding: 10, borderRadius: 8, background: "var(--db-pos-soft)", borderLeft: `3px solid ${C.green}` }}>
                                <div style={{ fontSize: 9, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>Sugerido por optimizador ({sug.pctChange > 0 ? "+" : ""}{sug.pctChange}%)</div>
                                <div style={{ fontSize: 14, fontWeight: 700, color: C.green }}>${sug.suggestedPrice} → ${Math.round(sugRev).toLocaleString()}</div>
                              </div>
                            )}
                          </div>

                          <div style={{ marginTop: 12, padding: "10px 12px", background: "var(--db-warn-soft)", borderLeft: `4px solid ${C.accent}`, borderRadius: 6, fontSize: 11, color: C.text, lineHeight: 1.55 }}>
                            <strong style={{ color: C.navy }}>Veredicto:</strong>{" "}
                            {Math.abs(sweetPct) < 0.5
                              ? "el precio actual ya está en el sweet spot — mantenerlo maximiza ingreso."
                              : sweetPct > 0
                                ? `el sweet spot está ${sweetPct.toFixed(1)}% arriba del precio actual (${lastMonth.price.toFixed(2)} → ${sweet.toFixed(2)}). Ingreso proyectado sube +${(((sweetRev - currentRev) / Math.max(currentRev, 1)) * 100).toFixed(1)}%.`
                                : `el sweet spot está ${Math.abs(sweetPct).toFixed(1)}% debajo del precio actual (${lastMonth.price.toFixed(2)} → ${sweet.toFixed(2)}). Ingreso proyectado sube +${(((sweetRev - currentRev) / Math.max(currentRev, 1)) * 100).toFixed(1)}% porque el volumen adicional compensa la pérdida unitaria.`}
                            {sug && Math.abs(sweetPct - sug.pctChange) > 5 && (
                              <span> <em>Nota:</em> el sweet spot teórico (${sweet.toFixed(2)}) difiere del sugerido por el optimizador (${sug.suggestedPrice}) porque éste aplica restricciones de ±30% y reglas de negocio.</span>
                            )}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </>
              );
            })()}

            <SectionHead ic="🎯">Demanda Real vs Predicha por Metodo</SectionHead>
            <div className="el-card" style={{ padding: 16, marginBottom: 14 }}>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={chartData} margin={{ top: 10, right: 10, left: -5, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--db-hair-2)" />
                  <XAxis dataKey="month" tick={{ fontSize: 9, fill: C.sub }} />
                  <YAxis tick={{ fontSize: 9, fill: C.sub }} />
                  <Tooltip content={<ChartTip />} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Line type="monotone" dataKey="unidades" name="Real" stroke={C.text} strokeWidth={2.5} dot={{ r: 3 }} />
                  {analysis.results.map(r => (
                    <Line key={r.id} type="monotone" dataKey={r.id + "_pred"} name={r.method + " Pred"} stroke={METHOD_COLORS[r.id]} strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            <SectionHead ic="🔍">Dispersión Precio vs Cantidad</SectionHead>
            <div className="el-card" style={{ padding: 16 }}>
              <ResponsiveContainer width="100%" height={220}>
                <ScatterChart margin={{ top: 10, right: 10, left: -5, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--db-hair-2)" />
                  <XAxis dataKey="price" name="Precio" tick={{ fontSize: 9, fill: C.sub }} tickFormatter={v => "$" + v} />
                  <YAxis dataKey="units" name="Unidades" tick={{ fontSize: 9, fill: C.sub }} />
                  <Tooltip cursor={{ strokeDasharray: "3 3" }} content={<ChartTip />} />
                  <Scatter data={scatterData} fill={C.blue} r={5} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══ Rule Builder Component ═══
function RuleBuilder({ allProducts, existingRules, compBySku, onClose, onSave }) {
  const [familyName, setFamilyName] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState({}); // sku -> true
  const [showRules, setShowRules] = useState(false);
  const [rules, setRules] = useState({
    maxPctChange: null, minMarginPct: null, maxMarginPct: null,
    minPriceFloor: null, maxPriceCeiling: null, priceAboveCompMin: null, roundingMode: null,
  });
  const cleanRules = () => {
    const out = {};
    for (const k of Object.keys(rules)) {
      const v = rules[k];
      if (v !== null && v !== "" && !(typeof v === "number" && !isFinite(v))) out[k] = v;
    }
    return out;
  };

  const results = useMemo(() => {
    if (!search || search.length < 2) return [];
    const s = search.toLowerCase();
    return allProducts.filter(p =>
      (p.sku_des || "").toLowerCase().includes(s) ||
      p.sku.toString().includes(s) ||
      (p.brand || "").toLowerCase().includes(s) ||
      (p.upc || "").includes(s)
    ).slice(0, 30);
  }, [search, allProducts]);

  const selectedSkus = Object.keys(selected).filter(k => selected[k]);
  const canSave = familyName.trim().length > 0 && selectedSkus.length > 0;

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "var(--db-scrim)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()}
        className="el-modal" style={{ maxWidth: 900, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: 18, borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.navy }}>➕ Nueva regla de familia</div>
          <button onClick={onClose} className="el-btn" style={{ padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600, color: C.sub }}>Cerrar ✕</button>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14, overflow: "hidden", flex: 1 }}>
          <div>
            <label style={{ fontSize: 11, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>Nombre de la familia</label>
            <input
              type="text" value={familyName} onChange={(e) => setFamilyName(e.target.value)}
              placeholder='ej. "Electrolit 625"'
              className="el-field" style={{ width: "100%", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginTop: 4, outline: "none" }}
            />
          </div>

          <div>
            <label style={{ fontSize: 11, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>Buscar productos (nombre, SKU, brand o UPC)</label>
            <input
              type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Empieza a escribir para buscar..."
              className="el-field" style={{ width: "100%", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginTop: 4, outline: "none" }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, flex: 1, minHeight: 0 }}>
            {/* Resultados de búsqueda */}
            <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ fontSize: 10, color: C.sub, fontWeight: 600, textTransform: "uppercase", marginBottom: 6 }}>Resultados {results.length > 0 && `(${results.length})`}</div>
              <div style={{ flex: 1, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 8, background: "var(--db-track-bg)" }}>
                {search.length < 2 ? (
                  <div style={{ padding: 30, textAlign: "center", color: C.muted, fontSize: 11 }}>Escribe al menos 2 caracteres para buscar</div>
                ) : results.length === 0 ? (
                  <div style={{ padding: 30, textAlign: "center", color: C.muted, fontSize: 11 }}>Sin resultados</div>
                ) : (
                  results.map(p => {
                    const img = compBySku[p.sku]?.image;
                    const isSel = !!selected[p.sku];
                    const conflict = existingRules[p.sku] && existingRules[p.sku] !== familyName;
                    return (
                      <div key={p.sku} onClick={() => setSelected(s => ({ ...s, [p.sku]: !s[p.sku] }))}
                        style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, background: isSel ? "var(--db-pos-soft)" : "transparent" }}>
                        <div style={{ width: 22, height: 22, background: "var(--db-surface-hi)", border: `2px solid ${isSel ? C.green : C.border}`, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          {isSel && <span style={{ color: C.green, fontWeight: 700, fontSize: 14 }}>✓</span>}
                        </div>
                        <div style={{ width: 28, height: 28, background: "var(--db-track-bg)", borderRadius: 4, overflow: "hidden", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {img ? <img src={img} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} onError={e => { e.target.style.display = "none"; }} /> : <span style={{ fontSize: 12 }}>📦</span>}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: C.navy, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.sku_des || p.sku}</div>
                          <div style={{ fontSize: 9, color: C.muted }}>SKU {p.sku} · {p.brand || ""}</div>
                          {conflict && <div style={{ fontSize: 9, color: C.accent, fontWeight: 600 }}>⚠️ Ya en familia "{existingRules[p.sku]}" (se reemplaza)</div>}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Seleccionados */}
            <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ fontSize: 10, color: C.sub, fontWeight: 600, textTransform: "uppercase", marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                <span>Seleccionados ({selectedSkus.length})</span>
                {selectedSkus.length > 0 && <button onClick={() => setSelected({})} style={{ padding: 0, background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 10 }}>Limpiar</button>}
              </div>
              <div style={{ flex: 1, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 8, background: "var(--db-track-bg)" }}>
                {selectedSkus.length === 0 ? (
                  <div style={{ padding: 30, textAlign: "center", color: C.muted, fontSize: 11 }}>Aún no has seleccionado productos</div>
                ) : (
                  selectedSkus.map(sku => {
                    const p = allProducts.find(x => x.sku === sku);
                    if (!p) return null;
                    return (
                      <div key={sku} style={{ padding: "6px 10px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                        <div style={{ flex: 1, color: C.navy, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.sku_des || sku}</div>
                        <button onClick={() => setSelected(s => ({ ...s, [sku]: false }))}
                          style={{ padding: "2px 8px", background: "var(--db-neg-soft)", border: "none", color: C.red, borderRadius: 4, cursor: "pointer", fontSize: 10 }}>✕</button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Reglas de negocio específicas para esta familia */}
        <div style={{ padding: "0 18px 14px" }}>
          <button onClick={() => setShowRules(s => !s)} style={{ padding: "8px 12px", border: `1px solid ${C.border}`, background: showRules ? C.card : "var(--db-track-bg)", borderRadius: 6, fontSize: 11, fontWeight: 600, color: C.navy, cursor: "pointer", width: "100%", textAlign: "left" }}>
            {showRules ? "▼" : "▶"} Reglas de negocio específicas para esta familia (opcional)
          </button>
          {showRules && (
            <div style={{ padding: 14, border: `1px dashed ${C.border}`, borderRadius: 6, marginTop: 8, background: "var(--db-track-bg)" }}>
              <div style={{ fontSize: 10, color: C.sub, marginBottom: 10, lineHeight: 1.5 }}>
                Estas reglas <strong>solo aplicarán a los productos de esta familia</strong> y sobreescriben las reglas globales. Deja vacío para usar las globales.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Cambio máx. ±%</label>
                  <input type="number" step="1" min="0" max="100"
                    value={rules.maxPctChange ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, maxPctChange: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                    placeholder="ej. 10"
                    className="el-field" style={{ width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Margen mín. %</label>
                  <input type="number" step="1" min="0" max="100"
                    value={rules.minMarginPct ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, minMarginPct: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                    placeholder="ej. 15"
                    className="el-field" style={{ width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Margen máx. %</label>
                  <input type="number" step="1" min="0" max="100"
                    value={rules.maxMarginPct ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, maxMarginPct: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                    placeholder="ej. 60"
                    className="el-field" style={{ width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Piso ($)</label>
                  <input type="number" step="0.01" min="0"
                    value={rules.minPriceFloor ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, minPriceFloor: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                    placeholder="0"
                    className="el-field" style={{ width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Techo ($)</label>
                  <input type="number" step="0.01" min="0"
                    value={rules.maxPriceCeiling ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, maxPriceCeiling: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                    placeholder="sin límite"
                    className="el-field" style={{ width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Max % vs comp. mín.</label>
                  <input type="number" step="1"
                    value={rules.priceAboveCompMin ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, priceAboveCompMin: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                    placeholder="ej. 5"
                    className="el-field" style={{ width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Redondeo</label>
                  <select
                    value={rules.roundingMode ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, roundingMode: e.target.value || null }))}
                    className="el-field" style={{ width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 12, marginTop: 4 }}
                  >
                    <option value="">Global</option>
                    <option value="none">Ninguno (2 decimales)</option>
                    <option value="integer">Entero</option>
                    <option value="ending_99">Terminación .99</option>
                    <option value="ending_95">Terminación .95</option>
                    <option value="nearest_5">Múltiplo de 5</option>
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: 14, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--db-track-bg)" }}>
          <div style={{ fontSize: 11, color: C.sub }}>
            {canSave ? `✓ Listo: "${familyName}" con ${selectedSkus.length} productos` : "Completa el nombre y selecciona al menos 1 producto"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} className="el-btn" style={{ padding: "9px 18px", fontSize: 12, color: C.sub, cursor: "pointer" }}>Cancelar</button>
            <button disabled={!canSave}
              onClick={() => onSave(familyName.trim(), selectedSkus, cleanRules())}
              className="el-btn-pri" style={{
                padding: "9px 18px", fontSize: 12, fontWeight: 700, cursor: canSave ? "pointer" : "not-allowed",
              }}>Guardar regla</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══ Cluster Popup Component (sortable) ═══
function ClusterPopup({ clusterPopup, onClose, onSelectSku }) {
  const [sortCfg, setSortCfg] = useState({ key: "revenue", dir: "desc" });
  const rows = useMemo(() => {
    const base = (clusterPopup.products || []).map(p => {
      const full = p._full || p;
      return {
        sku: p.sku,
        sku_des: p.sku_des,
        brand: p.brand,
        category: p.category,
        currentPrice: full.currentPrice,
        elasticity: p.elasticity,
        suggestedPrice: full.suggestedPrice,
        pctChange: full.pctChange,
        revenue: p.revenue,
      };
    });
    return sortRows(base, sortCfg);
  }, [clusterPopup.products, sortCfg]);
  const abcColor = { A: C.green, B: C.blue, C: C.accent, D: C.red };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "var(--db-scrim)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()}
        className="el-modal" style={{ maxWidth: 1100, width: "100%", maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 18, borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: C.sub, textTransform: "uppercase", fontWeight: 700 }}>Cluster</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.navy }}>
              <span style={{ padding: "2px 10px", borderRadius: 12, background: abcColor[clusterPopup.abc] + "22", color: abcColor[clusterPopup.abc], fontWeight: 700, fontSize: 14, marginRight: 8 }}>{clusterPopup.abc}</span>
              {clusterPopup.sub}
            </div>
            <div style={{ fontSize: 11, color: C.sub, marginTop: 4 }}>{rows.length} productos · Acción sugerida: <strong style={{ color: C.text }}>{clusterPopup.action}</strong></div>
          </div>
          <button onClick={onClose} className="el-btn" style={{ padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600, color: C.sub }}>Cerrar ✕</button>
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "var(--db-track-bg)", borderBottom: `2px solid ${C.border}`, position: "sticky", top: 0 }}>
                {[
                  { k: "sku", h: "SKU", align: "left" },
                  { k: "sku_des", h: "Producto", align: "left" },
                  { k: "category", h: "Categoría", align: "left" },
                  { k: "currentPrice", h: "Precio Actual" },
                  { k: "elasticity", h: "Elasticidad" },
                  { k: "suggestedPrice", h: "Precio Sugerido" },
                  { k: "pctChange", h: "Cambio" },
                  { k: "revenue", h: "Venta" },
                ].map((col, i) => (
                  <th key={i}
                    onClick={() => setSortCfg(s => ({ key: col.k, dir: s.key === col.k && s.dir === "asc" ? "desc" : "asc" }))}
                    style={{ padding: "10px 8px", textAlign: col.align || "center", color: C.sub, fontWeight: 600, fontSize: 9, textTransform: "uppercase", cursor: "pointer", userSelect: "none" }}>
                    {col.h} <span style={{ opacity: sortCfg.key === col.k ? 1 : 0.3, fontSize: 9 }}>{sortCfg.key === col.k ? (sortCfg.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.sku} style={{ borderBottom: "1px solid var(--db-track-bg)", background: i % 2 ? "var(--db-track-bg)" : "transparent", cursor: "pointer" }}
                  onClick={() => onSelectSku(p.sku)}>
                  <td style={{ padding: "8px 8px", fontSize: 10, color: C.muted }}>{p.sku}</td>
                  <td style={{ padding: "8px 8px" }}>
                    <div style={{ fontWeight: 600, color: C.navy, fontSize: 11 }}>{p.sku_des}</div>
                    <div style={{ fontSize: 9, color: C.muted }}>{p.brand}</div>
                  </td>
                  <td style={{ padding: "8px 8px", fontSize: 10, color: C.sub }}>{p.category}</td>
                  <td style={{ padding: "8px 8px", textAlign: "center" }}>{typeof p.currentPrice === "number" ? "$" + p.currentPrice.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-"}</td>
                  <td style={{ padding: "8px 8px", textAlign: "center", fontWeight: 700, color: p.elasticity < -1 ? C.red : p.elasticity < 0 ? C.green : C.accent }}>{typeof p.elasticity === "number" ? p.elasticity.toFixed(2) : "-"}</td>
                  <td style={{ padding: "8px 8px", textAlign: "center", fontWeight: 600 }}>{typeof p.suggestedPrice === "number" ? "$" + p.suggestedPrice.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-"}</td>
                  <td style={{ padding: "8px 8px", textAlign: "center" }}>
                    {typeof p.pctChange === "number" ? (
                      <Badge color={p.pctChange > 0.5 ? "green" : p.pctChange < -0.5 ? "red" : "blue"}>
                        {p.pctChange > 0 ? "+" : ""}{p.pctChange.toFixed(1)}%
                      </Badge>
                    ) : "-"}
                  </td>
                  <td style={{ padding: "8px 8px", textAlign: "center", fontSize: 10, color: C.sub }}>${Math.round(p.revenue).toLocaleString("es-MX")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
