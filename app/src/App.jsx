import { useState, useMemo, useEffect, useCallback, Component } from "react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, ComposedChart, Area, ScatterChart, Scatter, Cell, LabelList,
} from "recharts";
import { analyzeElasticity, suggestPrice, sanitizeElasticity } from "./elasticity";

/* ── Brand Colors (matching tablero_diseño) ── */
const C = {
  navy: "#0B2545", blue: "#134074", mid: "#1B6FB5", light: "#4DA8DA",
  accent: "#F59E0B", green: "#10B981", red: "#EF4444",
  bg: "#F8FAFC", card: "#FFFFFF", border: "#E2E8F0",
  text: "#0F172A", sub: "#64748B", muted: "#94A3B8",
};

const METHOD_COLORS = { ols: "#134074", loglog: "#7C3AED", arc: "#F59E0B" };

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
    return { level: "muy_baja", reco: "reject", label: "Sin datos — revisar", color: "#EF4444" };
  }
  // Elasticidad positiva o exactamente 0 = sin señal
  if (elasticity === null || elasticity === undefined || elasticity >= 0) {
    return { level: "baja", reco: "reject", label: "Sin señal — mantener", color: "#EF4444" };
  }
  if (mape < 20) return { level: "alta", reco: "auto_approve", label: "Alta — auto aprobar", color: "#10B981" };
  if (mape < 40) return { level: "media", reco: "auto_approve", label: "Media — auto aprobar", color: "#10B981" };
  if (mape < 60) return { level: "baja", reco: "review", label: "Baja — revisar", color: "#F59E0B" };
  return { level: "muy_baja", reco: "reject", label: "Muy baja — no aplicar", color: "#EF4444" };
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
function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background: accent ? `linear-gradient(135deg,${C.navy},${C.blue})` : C.card,
      border: accent ? "none" : `1px solid ${C.border}`,
      borderRadius: 10, padding: "13px 15px", flex: 1, minWidth: 120,
      boxShadow: accent ? "0 4px 16px rgba(11,37,69,0.2)" : "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <div style={{ fontSize: 10, color: accent ? "rgba(255,255,255,0.7)" : C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent ? "#fff" : C.navy, marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: accent ? "rgba(255,255,255,0.6)" : C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SectionHead({ children, ic }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, marginTop: 24 }}>
      <span style={{ fontSize: 16 }}>{ic}</span>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: C.navy, margin: 0 }}>{children}</h3>
      <div style={{ flex: 1, height: 1, background: `linear-gradient(90deg,${C.border},transparent)` }} />
    </div>
  );
}

function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 11, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
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

function Badge({ color, children }) {
  return (
    <span style={{
      background: color === "green" ? "rgba(16,185,129,0.12)" : color === "red" ? "rgba(239,68,68,0.12)" : color === "blue" ? "rgba(19,64,116,0.1)" : "rgba(245,158,11,0.12)",
      color: color === "green" ? C.green : color === "red" ? C.red : color === "blue" ? C.blue : C.accent,
      padding: "3px 10px", borderRadius: 16, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap",
    }}>
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
        padding: "10px 6px", textAlign: align, color: C.sub, fontWeight: 600,
        fontSize: 9, textTransform: "uppercase", whiteSpace: "nowrap",
        cursor: sortKey ? "pointer" : "default", userSelect: "none",
        width: w, minWidth: 50, position: "relative",
      }}
    >
      {label} {sortKey && <span style={{ opacity: isActive ? 1 : 0.3, marginLeft: 2 }}>{arrow}</span>}
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
  const bg = method === "ols" ? "rgba(19,64,116,0.1)" : method === "loglog" ? "rgba(124,58,237,0.1)" : "rgba(245,158,11,0.1)";
  const fg = METHOD_COLORS[method] || C.sub;
  const label = method === "ols" ? "OLS Lineal" : method === "loglog" ? "Log-Log" : "Arco Mid-Point";
  return <span style={{ background: bg, color: fg, padding: "3px 10px", borderRadius: 16, fontSize: 10, fontWeight: 600 }}>{label}</span>;
}

class ErrBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.log("ErrBoundary caught:", err, info); }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 20, background: "#FEF2F2", border: "2px solid #EF4444", borderRadius: 10, color: "#991B1B", fontFamily: "monospace", fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Error en {this.props.name || "componente"}:</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{String(this.state.err?.stack || this.state.err)}</div>
          <button onClick={() => this.setState({ err: null })} style={{ marginTop: 10, padding: "6px 12px", cursor: "pointer" }}>Reintentar</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Spinner() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "60vh", gap: 16 }}>
      <div style={{ width: 48, height: 48, border: `4px solid ${C.border}`, borderTop: `4px solid ${C.blue}`, borderRadius: "50%", animation: "spin 1s linear infinite" }} />
      <div style={{ color: C.sub, fontSize: 13 }}>Cargando datos...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ── MAIN APP ── */
export default function App() {
  const [data, setData] = useState(null);
  const [competitor, setCompetitor] = useState({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("portfolio");
  const [adminSection, setAdminSection] = useState("rules"); // sub-sección dentro del tab "Administración": rules | audit
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
  const [portfolioWidths, setPortfolioWidths] = useState({});
  const [subSort, setSubSort] = useState({ key: "revenue", dir: "desc" });
  const [auditLog, setAuditLog] = useState([]); // [{ ts, user, action, sku, family, detail, before, after }]
  const [currentUser, setCurrentUser] = useState(() => {
    try { return localStorage.getItem("elasticity_user") || "Diego Sosa"; } catch { return "Diego Sosa"; }
  });
  const [scenario, setScenario] = useState("balanced"); // balanced | aggressive | conservative | keep_margin | hold_price
  const [familyRules, setFamilyRules] = useState({}); // { sku: "Nombre de familia" }
  // Reglas de negocio específicas por familia (sobreescriben las globales cuando se activan)
  // { familyName: { maxPctChange, minMarginPct, maxMarginPct, minPriceFloor, maxPriceCeiling, priceAboveCompMin, roundingMode } }
  const [familyBusinessRules, setFamilyBusinessRules] = useState({});
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
  });
  const PAGE_SIZE = 20;

  useEffect(() => {
    Promise.all([
      fetch("/data.json").then(r => r.json()),
      fetch("/competitor.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ])
      .then(([d, comp]) => {
        setData(d);
        setCompetitor(comp || {});
        setLoading(false);
      })
      .catch(err => { console.error(err); setLoading(false); });
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
      if (fam && familyAnalysis[fam]) {
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
  const categories = useMemo(() => data ? [...new Set(data.products.map(p => p.category).filter(Boolean))].sort() : [], [data]);
  const classifications = useMemo(() => data ? [...new Set(data.products.map(p => p.fesa_classification).filter(Boolean))].sort() : [], [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.products.filter(p => {
      if (filterDept !== "all" && p.department !== filterDept) return false;
      if (filterCat !== "all" && p.category !== filterCat) return false;
      if (filterClass !== "all" && p.fesa_classification !== filterClass) return false;
      if (searchTerm) {
        const s = searchTerm.toLowerCase();
        return (p.sku_des || "").toLowerCase().includes(s) || p.sku.toString().includes(s) || (p.brand || "").toLowerCase().includes(s);
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
      const override = overrides[p.sku];
      const compMin = compBySku[p.sku]?.minPrice;
      // Reglas efectivas: familia > escenario > globales
      const effectiveRules = fam && familyBusinessRules[fam]
        ? { ...effectiveGlobalRules, ...familyBusinessRules[fam] }
        : effectiveGlobalRules;
      const ruled = applyBusinessRules(autoSuggestedRaw, currentPrice, currentMargin, compMin, effectiveRules);
      const autoSuggested = ruled.finalPrice;
      const confidence = confidenceFromMape(best?.mape, best?.elasticity);
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
        reason: sug?.reason ?? "",
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
  }, [data, filtered, allAnalysis, overrides, familyRules, familySuggest, compBySku, effectiveGlobalRules, familyBusinessRules, approvals]);

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

  // Cálculo global de clusters para que también se muestre en el Portafolio
  const clusterInfo = useMemo(() => {
    if (!data || !portfolioData.length) return { map: {}, groups: {} };
    const rows = portfolioData.filter(p => p.elasticity !== null).map(p => {
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
        elasticitySafe: sanitizeElasticity(p.elasticity),
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
    for (const cls of Object.keys(groups)) {
      const g = groups[cls];
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
      g.forEach((r, i) => {
        const key = `${cls}-${labels[assign[i]]}`;
        labelMap[r.sku] = { abc: cls, sub: labels[assign[i]], key };
        if (!productsByCluster[key]) productsByCluster[key] = [];
        productsByCluster[key].push(r);
      });
    }
    return { map: labelMap, groups, productsByCluster };
  }, [data, portfolioData]);

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

  if (loading) return <Spinner />;
  if (!data) return <div style={{ padding: 40, textAlign: "center", color: C.red }}>Error cargando datos</div>;

  const tabs = [
    { id: "portfolio", label: "Sugerencia de Precios", ic: "💰" },
    { id: "clusters", label: "Clusters", ic: "🧬" },
    { id: "admin", label: "Administración", ic: "⚙️" },
    { id: "glossary", label: "Glosario", ic: "📚" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, sans-serif" }}>

      {/* HEADER */}
      <header style={{ background: `linear-gradient(135deg,${C.navy},${C.blue})`, padding: "0 20px", boxShadow: "0 2px 12px rgba(11,37,69,0.15)" }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 0", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 38, height: 38, borderRadius: 8, background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, color: "#fff" }}>DB</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Data Bunker</div>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.6)" }}>www.data-bunker.ai</div>
            </div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", letterSpacing: 1 }}>PRICE ELASTICITY ENGINE</div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)" }}>Análisis de Elasticidad de Precios</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ padding: "5px 12px", borderRadius: 7, background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", fontSize: 11, color: "rgba(255,255,255,0.8)" }}>
              <span style={{ color: C.accent, fontWeight: 700 }}>{data.products.length.toLocaleString()}</span> SKUs
            </div>
            <div style={{ padding: "5px 10px", borderRadius: 7, background: "rgba(16,185,129,0.2)", border: "1px solid rgba(16,185,129,0.3)", fontSize: 10, color: "#6EE7B7", fontWeight: 600 }}>● LIVE</div>
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "0 20px" }}>

        {/* TABS */}
        <div style={{ display: "flex", gap: 2, margin: "14px 0", background: "#EFF3F8", borderRadius: 10, padding: 3 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, padding: "9px 8px", borderRadius: 8, border: "none", cursor: "pointer", minWidth: 120,
              background: tab === t.id ? C.card : "transparent",
              color: tab === t.id ? C.navy : C.sub,
              fontSize: 12, fontWeight: 600, outline: "none", display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
              boxShadow: tab === t.id ? "0 2px 6px rgba(0,0,0,0.06)" : "none",
            }}>
              <span>{t.ic}</span> {t.label}
            </button>
          ))}
        </div>

        {/* FILTERS */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
          <input
            type="text" placeholder="Buscar SKU, nombre, brand..."
            value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
            style={{ flex: "1 1 200px", padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12, outline: "none", minWidth: 180 }}
          />
          <select value={filterDept} onChange={e => setFilterDept(e.target.value)} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 11, color: C.text, outline: "none" }}>
            <option value="all">Todos Departamentos</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 11, color: C.text, outline: "none" }}>
            <option value="all">Todas Categorias</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filterClass} onChange={e => setFilterClass(e.target.value)} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 11, color: C.text, outline: "none" }}>
            <option value="all">Todas Clasificaciones</option>
            {classifications.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <div style={{ fontSize: 11, color: C.sub }}>{filtered.length.toLocaleString()} productos</div>
        </div>

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

          // Comparación del impacto de cada escenario sobre el portafolio (para el selector de escenario)
          const scenarioComparison = Object.keys(SCENARIOS).map(key => {
            const sc = SCENARIOS[key];
            const rules = sc.rules ? { ...businessRules, ...sc.rules } : businessRules;
            let totalCurrent = 0, totalProjected = 0, up = 0, down = 0, noChange = 0;
            for (const p of portfolioData) {
              if (p.elasticity === null) continue;
              const compMin = compBySku[p.sku]?.minPrice;
              const fam = familyRules[p.sku];
              const eff = fam && familyBusinessRules[fam] ? { ...rules, ...familyBusinessRules[fam] } : rules;
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
            <div>
              {/* Selector de escenario (antes en el tab "Simulador") */}
              <SectionHead ic="🎯">Escenario de Precios</SectionHead>
              <div style={{ background: "#EEF2FF", border: `1px solid #C7D2FE`, borderLeft: `4px solid ${C.blue}`, borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 11, lineHeight: 1.6, color: C.text }}>
                <strong style={{ color: C.navy }}>💡</strong> Cada escenario aplica un conjunto distinto de reglas globales sobre los mismos modelos de elasticidad. Las reglas por familia siempre tienen prioridad. El escenario elegido se refleja de inmediato en las sugerencias de abajo.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, marginBottom: 22 }}>
                {Object.keys(SCENARIOS).map(key => {
                  const sc = SCENARIOS[key];
                  const isActive = scenario === key;
                  const summary = scenarioComparison.find(c => c.key === key);
                  const deltaPct = summary && summary.totalCurrent > 0 ? ((summary.totalProjected - summary.totalCurrent) / summary.totalCurrent) * 100 : 0;
                  return (
                    <div key={key} onClick={() => {
                      setScenario(key);
                      logAudit({ action: "SCENARIO_CHANGE", detail: `Escenario: ${sc.label}`, before: scenario, after: key });
                    }} style={{
                      padding: 14, borderRadius: 10, cursor: "pointer",
                      background: isActive ? `linear-gradient(135deg,${C.navy},${C.blue})` : C.card,
                      color: isActive ? "#fff" : C.text,
                      border: isActive ? "none" : `1px solid ${C.border}`,
                      boxShadow: isActive ? "0 4px 16px rgba(11,37,69,0.25)" : "0 1px 3px rgba(0,0,0,0.04)",
                    }}>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{sc.label}</div>
                      <div style={{ fontSize: 10, color: isActive ? "rgba(255,255,255,0.75)" : C.sub, lineHeight: 1.5, marginBottom: 8 }}>{sc.desc}</div>
                      <div style={{ fontSize: 10, color: isActive ? "rgba(255,255,255,0.6)" : C.muted }}>
                        Proyección: <strong style={{ color: isActive ? "#BBF7D0" : (deltaPct >= 0 ? C.green : C.red) }}>
                          {deltaPct > 0 ? "+" : ""}{deltaPct.toFixed(2)}%
                        </strong>
                        {" · ↑"}{summary?.up ?? 0} ↓{summary?.down ?? 0} ={summary?.noChange ?? 0}
                      </div>
                    </div>
                  );
                })}
              </div>

              <SectionHead ic="💰">Sugerencia de Precios</SectionHead>

              {/* Nota sobre la metodología del optimizador */}
              <div style={{ background: "#F0FDF4", border: `1px solid #86EFAC`, borderLeft: `4px solid ${C.green}`, borderRadius: 10, padding: "12px 14px", marginBottom: 14, fontSize: 11, lineHeight: 1.6, color: C.text }}>
                <div style={{ fontWeight: 700, color: C.navy, marginBottom: 4 }}>⚙️ Cómo trabaja el optimizador</div>
                El optimizador busca numéricamente dentro del rango ±30% el precio que maximiza
                <code style={{ background: "#DCFCE7", padding: "1px 6px", borderRadius: 4, margin: "0 4px" }}>P·Q(P)</code>
                bajo
                <code style={{ background: "#DCFCE7", padding: "1px 6px", borderRadius: 4, margin: "0 4px" }}>Q = Q₀·(P/P₀)^E</code>,
                garantizando que el ingreso proyectado sea siempre ≥ el actual. Elasticidades con <strong>E ≥ 0 (Giffen/atípica)</strong> se tratan como <em>sin señal</em> → mantener precio.
                El volumen proyectado se acota a <strong>±5×</strong> el actual para evitar proyecciones infinitas en outliers.
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                <StatCard label="Productos Analizados" value={withSuggestion.length} />
                <StatCard label="Subir Precio" value={increases.length} sub={`${(increases.length / Math.max(withSuggestion.length, 1) * 100).toFixed(0)}%`} />
                <StatCard label="Bajar Precio" value={decreases.length} sub={`${(decreases.length / Math.max(withSuggestion.length, 1) * 100).toFixed(0)}%`} />
                <StatCard label="Mantener" value={maintains.length} />
                <StatCard label="Cambio Promedio" value={avgChange.toFixed(2) + "%"} accent />
              </div>

              {(() => {
                const byConf = { alta: 0, media: 0, baja: 0, muy_baja: 0 };
                withSuggestion.forEach(r => { byConf[r.confidence] = (byConf[r.confidence] || 0) + 1; });
                const autoOk = byConf.alta + byConf.media;
                return (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 14 }}>
                    <div style={{ background: "rgba(16,185,129,0.08)", border: `1px solid #86EFAC`, borderRadius: 10, padding: 12 }}>
                      <div style={{ fontSize: 9, color: C.sub, textTransform: "uppercase", fontWeight: 700 }}>✓ Confianza Alta</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: C.green }}>{byConf.alta}</div>
                      <div style={{ fontSize: 9, color: C.muted }}>MAPE &lt; 20%</div>
                    </div>
                    <div style={{ background: "rgba(16,185,129,0.05)", border: `1px solid #86EFAC66`, borderRadius: 10, padding: 12 }}>
                      <div style={{ fontSize: 9, color: C.sub, textTransform: "uppercase", fontWeight: 700 }}>✓ Confianza Media</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: C.green, opacity: 0.85 }}>{byConf.media}</div>
                      <div style={{ fontSize: 9, color: C.muted }}>MAPE 20-40%</div>
                    </div>
                    <div style={{ background: "rgba(245,158,11,0.08)", border: `1px solid #FCD34D`, borderRadius: 10, padding: 12 }}>
                      <div style={{ fontSize: 9, color: C.sub, textTransform: "uppercase", fontWeight: 700 }}>⚠ Revisar</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: C.accent }}>{byConf.baja}</div>
                      <div style={{ fontSize: 9, color: C.muted }}>MAPE 40-60%</div>
                    </div>
                    <div style={{ background: "rgba(239,68,68,0.08)", border: `1px solid #FCA5A5`, borderRadius: 10, padding: 12 }}>
                      <div style={{ fontSize: 9, color: C.sub, textTransform: "uppercase", fontWeight: 700 }}>✗ No Aplicar</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: C.red }}>{byConf.muy_baja}</div>
                      <div style={{ fontSize: 9, color: C.muted }}>MAPE &gt; 60% o sin señal</div>
                    </div>
                    <div style={{ background: "linear-gradient(135deg,#134074,#1B6FB5)", color: "#fff", borderRadius: 10, padding: 12 }}>
                      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.8)", textTransform: "uppercase", fontWeight: 700 }}>🤖 Auto-aplicables</div>
                      <div style={{ fontSize: 20, fontWeight: 800 }}>{autoOk}</div>
                      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.7)" }}>{withSuggestion.length > 0 ? ((autoOk / withSuggestion.length) * 100).toFixed(0) : 0}% del portafolio</div>
                    </div>
                  </div>
                );
              })()}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 14 }}>
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 9, color: C.sub, textTransform: "uppercase", fontWeight: 600 }}>Venta Total Actual (último mes)</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: C.blue, marginTop: 4 }}>${totalSalesCurrent.toLocaleString("es-MX", { maximumFractionDigits: 0 })}</div>
                  <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>Precio × unidades del último mes</div>
                </div>
                <div style={{ background: "linear-gradient(135deg,#059669,#10B981)", color: "#fff", borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", fontWeight: 600 }}>Venta Proyectada (c/ todos los sugeridos)</div>
                  <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>${totalSalesSuggested.toLocaleString("es-MX", { maximumFractionDigits: 0 })}</div>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.8)", marginTop: 2 }}>
                    Δ {(((totalSalesSuggested - totalSalesCurrent) / Math.max(totalSalesCurrent, 1)) * 100).toFixed(2)}% vs actual
                  </div>
                </div>
                <div style={{ background: C.card, border: `2px solid ${C.accent}`, borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 9, color: C.sub, textTransform: "uppercase", fontWeight: 600 }}>Venta c/ Configuración Aprobada</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: C.accent, marginTop: 4 }}>${approvedSales.toLocaleString("es-MX", { maximumFractionDigits: 0 })}</div>
                  <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>
                    ✓ {approvedCount} aprobados · ✗ {rejectedCount} rechazados · {withSuggestion.length - approvedCount - rejectedCount} pendientes
                  </div>
                </div>
              </div>

              {/* Upload + acciones */}
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <div style={{ fontSize: 11, color: C.sub, marginRight: 8 }}>
                  <strong style={{ color: C.navy }}>📤 Cargar CSV (UPC + precio)</strong> para sobrescribir el precio sugerido de productos específicos:
                </div>
                <label style={{ padding: "7px 12px", background: `linear-gradient(135deg,${C.navy},${C.blue})`, color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                  Subir CSV
                  <input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => handlePortfolioUpload(e.target.files?.[0])} />
                </label>
                <button onClick={() => {
                  const sample = "upc,price\n7501008071342,25\n7500478042401,30\n";
                  const blob = new Blob([sample], { type: "text/csv" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a"); a.href = url; a.download = "plantilla_upc_precio.csv"; a.click();
                  URL.revokeObjectURL(url);
                }} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, fontSize: 11, color: C.sub, cursor: "pointer" }}>
                  Plantilla
                </button>
                {Object.keys(overrides).length > 0 && (
                  <button onClick={() => { setOverrides({}); setUploadInfo(null); }} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, fontSize: 11, color: C.red, cursor: "pointer" }}>
                    Limpiar overrides ({Object.keys(overrides).length})
                  </button>
                )}
                <div style={{ flex: 1 }} />
                <button onClick={downloadPortfolioCSV} style={{
                  padding: "7px 14px", borderRadius: 6, border: "none",
                  background: "linear-gradient(135deg,#059669,#10B981)", color: "#fff",
                  fontSize: 11, fontWeight: 700, cursor: "pointer",
                }}>Descargar CSV</button>
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
                }} style={{
                  padding: "7px 12px", borderRadius: 6, border: "none", background: `linear-gradient(135deg,${C.green},#059669)`, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", boxShadow: "0 2px 6px rgba(16,185,129,0.25)",
                }}>🤖 Auto-decidir por confianza</button>
                <button onClick={() => {
                  const all = {};
                  portfolioData.forEach(r => { if (r.elasticity !== null) all[r.sku] = "approved"; });
                  setApprovals(all);
                  logAudit({ action: "BULK_APPROVE_ALL", detail: `Aprobar todos: ${Object.keys(all).length} SKUs` });
                }} style={{
                  padding: "7px 12px", borderRadius: 6, border: `1px solid ${C.green}`, background: "rgba(16,185,129,0.08)", color: C.green, fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}>✓ Aprobar todos</button>
                <button onClick={() => {
                  const count = Object.keys(approvals).length;
                  setApprovals({});
                  logAudit({ action: "BULK_CLEAR", detail: `Limpiar ${count} decisiones` });
                }} style={{
                  padding: "7px 12px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.sub, fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}>Limpiar decisiones</button>
              </div>

              {uploadError && <div style={{ marginBottom: 10, padding: 10, background: "rgba(239,68,68,0.1)", color: C.red, borderRadius: 8, fontSize: 11 }}>{uploadError}</div>}
              {uploadInfo && (
                <div style={{ marginBottom: 10, padding: 10, background: "rgba(19,64,116,0.06)", borderRadius: 8, fontSize: 11, color: C.text }}>
                  📥 Upload: <strong>{uploadInfo.matched}</strong> productos con precio manual aplicado · {uploadInfo.notFound} UPCs no encontrados · {uploadInfo.invalid} filas inválidas
                </div>
              )}

              <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 1700, tableLayout: "fixed" }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC", borderBottom: `2px solid ${C.border}` }}>
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
                        <tr key={r.sku} style={{ borderBottom: "1px solid #F1F5F9", background: decision === "approved" ? "rgba(16,185,129,0.05)" : decision === "rejected" ? "rgba(239,68,68,0.04)" : (idx % 2 ? "#FAFBFC" : "#fff") }}>
                          <td style={{ padding: "6px 6px", cursor: "pointer" }} onClick={() => setDetailSku(r.sku)}>
                            <div style={{ width: 30, height: 30, background: "#F1F5F9", borderRadius: 4, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              {comp?.image ? <img src={comp.image} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} onError={e => { e.target.style.display = "none"; }} /> : <span style={{ fontSize: 12, color: C.muted }}>📦</span>}
                            </div>
                          </td>
                          <td style={{ padding: "8px 6px", fontSize: 10, color: C.muted, cursor: "pointer" }} onClick={() => setDetailSku(r.sku)}>{r.sku}</td>
                          <td style={{ padding: "8px 6px", fontSize: 10, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.upc || "-"}</td>
                          <td style={{ padding: "8px 6px", cursor: "pointer", overflow: "hidden" }} onClick={() => setDetailSku(r.sku)}>
                            <div style={{ fontWeight: 600, color: C.navy, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.sku_des || r.sku}</div>
                            <div style={{ fontSize: 9, color: C.muted, display: "flex", alignItems: "center", gap: 4 }}>
                              {r.brand}
                              {r.family && <span style={{ background: "rgba(19,64,116,0.12)", color: C.blue, padding: "1px 6px", borderRadius: 4, fontSize: 8, fontWeight: 700 }}>👪 {r.family}</span>}
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
                                background: r.isOverridden ? "#FFFBEB" : C.card,
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
                          <td style={{ padding: "8px 6px", textAlign: "center", fontWeight: 700, color: decision === "approved" ? C.green : C.navy, background: decision === "approved" ? "rgba(16,185,129,0.08)" : "transparent" }}>
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
                                background: decision === "approved" ? C.green : "rgba(16,185,129,0.12)",
                                color: decision === "approved" ? "#fff" : C.green,
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
                                background: decision === "rejected" ? C.red : "rgba(239,68,68,0.12)",
                                color: decision === "rejected" ? "#fff" : C.red,
                              }}>✗</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 12, marginBottom: 24 }}>
                <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, fontSize: 11, cursor: page === 0 ? "default" : "pointer", opacity: page === 0 ? 0.4 : 1 }}>Anterior</button>
                <span style={{ fontSize: 11, color: C.sub }}>{page + 1} / {totalPages || 1}</span>
                <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, fontSize: 11, cursor: page >= totalPages - 1 ? "default" : "pointer", opacity: page >= totalPages - 1 ? 0.4 : 1 }}>Siguiente</button>
              </div>
            </div>
          );
        })()}</ErrBoundary>}

        {/* ═══ CLUSTERS TAB ═══ */}
        {tab === "clusters" && (() => {
          // Construyo filas con las features del cluster
          const rows = portfolioData.filter(p => p.elasticity !== null).map(p => {
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
              elasticitySafe: sanitizeElasticity(p.elasticity),
              cv,
              priceRange,
              mape: p.mape,
            };
          });

          const abc = abcClassify(rows);
          rows.forEach(r => r.abc = abc[r.sku]);

          // Dentro de cada clase ABCD corro k-means (k=3) sobre [elasticidad, CV, rango precio]
          // Primero normalizo
          const groups = { A: [], B: [], C: [], D: [] };
          rows.forEach(r => groups[r.abc]?.push(r));
          const clusterLabels = {};
          const subclusterMeta = {};
          for (const cls of Object.keys(groups)) {
            const g = groups[cls];
            if (g.length === 0) continue;
            const feats = g.map(r => [
              Math.max(-4, Math.min(0, r.elasticitySafe)),
              Math.max(0, Math.min(3, r.cv)),
              Math.max(0, Math.min(1, r.priceRange)),
            ]);
            // normalizo columnas
            for (let c = 0; c < 3; c++) {
              const col = feats.map(f => f[c]);
              const mn = Math.min(...col), mx = Math.max(...col);
              const range = mx - mn || 1;
              feats.forEach(f => { f[c] = (f[c] - mn) / range; });
            }
            const k = Math.min(3, g.length);
            const assign = kmeans(feats, k);
            // Caracterizo sub-clusters por la elasticidad promedio para etiquetarlos
            const subStats = Array.from({ length: k }, () => ({ ids: [], elastSum: 0, cvSum: 0 }));
            g.forEach((r, i) => {
              const a = assign[i];
              subStats[a].ids.push(r.sku);
              subStats[a].elastSum += r.elasticitySafe;
              subStats[a].cvSum += r.cv;
            });
            // Nombres según elasticidad promedio
            const labels = subStats.map(s => {
              const avgE = s.elastSum / Math.max(s.ids.length, 1);
              const avgCv = s.cvSum / Math.max(s.ids.length, 1);
              if (Math.abs(avgE) >= 1.5) return "Elásticos (|E|≥1.5)";
              if (Math.abs(avgE) >= 0.7) return "Moderadamente elásticos";
              if (avgCv > 0.5) return "Estables / volátiles en volumen";
              return "Inelásticos estables";
            });
            g.forEach((r, i) => {
              clusterLabels[r.sku] = `${cls}-${labels[assign[i]]}`;
              subclusterMeta[`${cls}-${labels[assign[i]]}`] = labels[assign[i]];
            });
          }

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

              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 14, fontSize: 11, color: C.sub, lineHeight: 1.6 }}>
                Se corre una <strong>clasificación Pareto ABCD por ingreso</strong> (A: top 70% del revenue, B: +20%, C: +8%, D: últimos 2%). Dentro de cada clase se corre un <strong>k-means (k=3)</strong> sobre 3 features normalizadas: <code>elasticidad</code>, <code>coeficiente de variación de ventas</code> y <code>rango de variación de precios</code>. Esto agrupa productos con comportamiento similar dentro de cada segmento de relevancia para tomar decisiones diferenciadas.
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
              <div style={{ background: C.card, borderRadius: 10, padding: 16, border: `1px solid ${C.border}`, marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: C.sub, marginBottom: 12, lineHeight: 1.5 }}>
                  Cada barra suma el <strong>ingreso total</strong> de los productos (con señal de elasticidad) que caen en esa banda. En vez de un punto por producto, muestra <strong>dónde se concentra tu dinero</strong> según qué tan riesgoso es mover el precio. La etiqueta a la derecha es el % del ingreso analizado.
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={elastBands} layout="vertical" margin={{ top: 6, right: 56, left: 10, bottom: 6 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" horizontal={false} />
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
                <div style={{ marginTop: 12, padding: "10px 12px", background: "#F0FDF4", borderLeft: `4px solid ${C.green}`, borderRadius: 6, fontSize: 11, color: C.text, lineHeight: 1.55 }}>
                  <strong style={{ color: C.navy }}>💡 Insight:</strong> el <strong style={{ color: C.green }}>{inelBand.pct.toFixed(0)}%</strong> de tu ingreso analizado (${inelBand.revenue.toLocaleString("es-MX")}, {inelBand.count} SKUs) está en productos <strong>inelásticos</strong>: los candidatos más seguros para subir precio, porque el volumen reacciona poco al aumento. En cambio, el <strong style={{ color: C.red }}>{vhighBand.pct.toFixed(0)}%</strong> (${vhighBand.revenue.toLocaleString("es-MX")}) está en productos <strong>muy elásticos</strong>, donde subir precio puede reducir el ingreso total: ahí conviene sostener o bajar precio.
                </div>
              </div>

              {/* Sub-clusters table */}
              <SectionHead ic="🧩">Sub-clusters de Comportamiento (k-means dentro de cada clase ABCD)</SectionHead>
              <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflowX: "auto", marginBottom: 14 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC", borderBottom: `2px solid ${C.border}` }}>
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
                      if (absE >= 1.5) action = "Bajar precio de forma controlada, alta sensibilidad";
                      else if (absE >= 0.7) action = "Analizar caso por caso, evaluar contra competencia";
                      else if (b.avgElast === 0) action = "Revisar datos antes de actuar";
                      else action = "Candidato a subir precio con bajo riesgo";
                      return (
                        <tr key={i} style={{ borderBottom: "1px solid #F1F5F9", background: i % 2 ? "#FAFBFC" : "#fff", cursor: "pointer" }}
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

              <div style={{ background: "#EEF2FF", border: `1px solid #C7D2FE`, borderRadius: 10, padding: 14, fontSize: 11, color: C.text, lineHeight: 1.6 }}>
                <div style={{ fontWeight: 700, color: C.navy, marginBottom: 4 }}>💡 Cómo leer esto</div>
                Los productos <strong>clase A</strong> concentran la mayor parte del ingreso y merecen decisiones tomadas una por una. Dentro de A, el sub-cluster "Elásticos" es el más peligroso de subir precio — el volumen reacciona más que el margen ganado. Los <strong>inelásticos estables</strong> de clase A suelen ser los mejores candidatos para optimización de precio porque mueven mucho ingreso con poco riesgo. Las clases C y D son típicamente candidatos a racionalización de surtido.
              </div>
            </div>
          );
        })()}

        {/* ═══ ADMIN TAB (Reglas + Auditoría en sub-secciones) ═══ */}
        {tab === "admin" && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16, background: "#EFF3F8", borderRadius: 10, padding: 4 }}>
            {[
              { id: "rules", label: "Reglas de negocio", ic: "⚖️" },
              { id: "audit", label: "Auditoría", ic: "🔍" },
            ].map(s => {
              const active = adminSection === s.id;
              return (
                <button key={s.id} onClick={() => setAdminSection(s.id)} style={{
                  flex: "1 1 160px", minWidth: 140, padding: "9px 14px", borderRadius: 8, border: "none", cursor: "pointer",
                  background: active ? C.card : "transparent",
                  color: active ? C.navy : C.sub,
                  fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  boxShadow: active ? "0 2px 6px rgba(0,0,0,0.06)" : "none",
                }}>
                  <span>{s.ic}</span> {s.label}
                </button>
              );
            })}
          </div>
        )}

        {/* ── Admin › Reglas ── */}
        {tab === "admin" && adminSection === "rules" && (() => {
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
            return { name, skus, products, totalUnits, avgPrice, analysis };
          }).sort((a, b) => b.totalUnits - a.totalUnits);

          const handleFamilyUpload = (file) => {
            if (!file || !data) return;
            setFamilyUploadMsg("");
            const reader = new FileReader();
            reader.onload = (ev) => {
              try {
                const text = String(ev.target.result).replace(/^\uFEFF/, "");
                const lines = text.split(/\r?\n/).filter(l => l.trim());
                if (lines.length < 2) { setFamilyUploadMsg("Archivo vacío"); return; }
                const header = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/"/g, ""));
                const famIdx = header.findIndex(h => h === "family" || h === "familia" || h === "family_name");
                const upcIdx = header.findIndex(h => h === "upc");
                const skuIdx = header.findIndex(h => h === "sku");
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
                let matched = 0, notFound = 0, rulesApplied = 0;
                for (let i = 1; i < lines.length; i++) {
                  const parts = lines[i].split(",").map(x => x.trim().replace(/"/g, ""));
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
                setFamilyUploadMsg(`✓ ${matched} productos asignados · ${notFound} no encontrados · ${rulesApplied} familias con reglas específicas`);
              } catch (err) { setFamilyUploadMsg("Error: " + err.message); }
            };
            reader.readAsText(file);
          };

          return (
            <div style={{ paddingBottom: 30 }}>
              <SectionHead ic="⚖️">Reglas de Negocio (aplica a todo el portafolio)</SectionHead>

              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.6, marginBottom: 14 }}>
                  Estas reglas se aplican <strong>antes de mostrar el precio sugerido</strong> en el Portafolio. Si una regla se activa y modifica el precio, la razón queda registrada en la columna de razón. Deja un campo vacío para desactivar esa regla.
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Cambio máximo vs precio actual</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <input type="number" min="0" max="100" step="1"
                        value={businessRules.maxPctChange ?? ""}
                        onChange={(e) => setBusinessRules(r => ({ ...r, maxPctChange: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        style={{ width: 80, padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12 }}
                      />
                      <span style={{ fontSize: 12, color: C.sub }}>% (±)</span>
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Limita cuánto puede subir o bajar el precio sugerido respecto al actual. <em>Por defecto 30%.</em></div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Margen mínimo permitido</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <input type="number" min="0" max="100" step="1"
                        value={businessRules.minMarginPct ?? ""}
                        onChange={(e) => setBusinessRules(r => ({ ...r, minMarginPct: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        placeholder="ej. 15"
                        style={{ width: 80, padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12 }}
                      />
                      <span style={{ fontSize: 12, color: C.sub }}>%</span>
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Evita sugerir bajar precio hasta que el margen caiga debajo de este valor.</div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Margen máximo permitido</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <input type="number" min="0" max="100" step="1"
                        value={businessRules.maxMarginPct ?? ""}
                        onChange={(e) => setBusinessRules(r => ({ ...r, maxMarginPct: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        placeholder="ej. 60"
                        style={{ width: 80, padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12 }}
                      />
                      <span style={{ fontSize: 12, color: C.sub }}>%</span>
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Capa precio para no superar un margen objetivo (útil para productos regulados o KVI).</div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Max sobre competencia mínima</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <input type="number" step="1"
                        value={businessRules.priceAboveCompMin ?? ""}
                        onChange={(e) => setBusinessRules(r => ({ ...r, priceAboveCompMin: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        placeholder="ej. 5"
                        style={{ width: 80, padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12 }}
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
                        value={businessRules.minPriceFloor ?? ""}
                        onChange={(e) => setBusinessRules(r => ({ ...r, minPriceFloor: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        placeholder="0"
                        style={{ width: 100, padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12 }}
                      />
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Precio mínimo global (sin importar la sugerencia).</div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Techo absoluto</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <span style={{ fontSize: 12, color: C.sub }}>$</span>
                      <input type="number" step="0.01" min="0"
                        value={businessRules.maxPriceCeiling ?? ""}
                        onChange={(e) => setBusinessRules(r => ({ ...r, maxPriceCeiling: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                        placeholder="sin límite"
                        style={{ width: 100, padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12 }}
                      />
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Precio máximo global.</div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Redondeo psicológico</label>
                    <select
                      value={businessRules.roundingMode}
                      onChange={(e) => setBusinessRules(r => ({ ...r, roundingMode: e.target.value }))}
                      style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, marginTop: 4 }}
                    >
                      <option value="none">Ninguno (2 decimales)</option>
                      <option value="integer">Entero</option>
                      <option value="ending_99">Terminación .99</option>
                      <option value="ending_95">Terminación .95</option>
                      <option value="nearest_5">Múltiplo de 5</option>
                    </select>
                    <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Aplica patrón de pricing psicológico al precio final.</div>
                  </div>
                </div>

                <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => {
                    setBusinessRules({
                      maxPctChange: 30, minMarginPct: null, maxMarginPct: null,
                      minPriceFloor: null, maxPriceCeiling: null,
                      priceAboveCompMin: null, roundingMode: "none",
                    });
                    logAudit({ action: "RULES_RESET_GLOBAL", detail: "Reset reglas de negocio globales a default" });
                  }} style={{ padding: "7px 14px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.sub, fontSize: 11, cursor: "pointer" }}>
                    Resetear valores
                  </button>
                  <div style={{ flex: 1, fontSize: 11, color: C.sub, alignSelf: "center" }}>
                    <strong style={{ color: C.navy }}>Activas ahora:</strong>{" "}
                    {[
                      businessRules.maxPctChange ? `cambio máx ${businessRules.maxPctChange}%` : null,
                      businessRules.minMarginPct ? `margen mín ${businessRules.minMarginPct}%` : null,
                      businessRules.maxMarginPct ? `margen máx ${businessRules.maxMarginPct}%` : null,
                      businessRules.priceAboveCompMin !== null ? `max ${businessRules.priceAboveCompMin}% vs comp.` : null,
                      businessRules.minPriceFloor ? `piso $${businessRules.minPriceFloor}` : null,
                      businessRules.maxPriceCeiling ? `techo $${businessRules.maxPriceCeiling}` : null,
                      businessRules.roundingMode !== "none" ? `redondeo ${businessRules.roundingMode}` : null,
                    ].filter(Boolean).join(" · ") || "ninguna"}
                  </div>
                </div>
              </div>

              <SectionHead ic="📋">Reglas de Familia de Productos</SectionHead>

              <div style={{ background: "#EEF2FF", border: `1px solid #C7D2FE`, borderLeft: `4px solid ${C.blue}`, borderRadius: 10, padding: 14, marginBottom: 14, fontSize: 11, lineHeight: 1.6, color: C.text }}>
                <div style={{ fontWeight: 700, color: C.navy, marginBottom: 4 }}>💡 Cómo funciona</div>
                Carga un CSV con productos que pertenecen a la misma familia (ej. todos los sabores de <strong>Electrolit 625</strong>). Cuando un SKU tiene una regla de familia asignada, la elasticidad se calcula a partir de las <strong>ventas agregadas de toda la familia</strong>, y el <strong>mismo precio final sugerido</strong> se aplica a todos los SKUs (porque no puedes tener dos sabores del mismo producto a precios distintos en la tienda). Los SKUs sin regla siguen calculándose de forma individual.
              </div>

              {/* Crear visualmente */}
              <div style={{ background: "linear-gradient(135deg," + C.navy + "," + C.blue + ")", color: "#fff", borderRadius: 12, padding: 18, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>✨ Crear regla visualmente</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.75)", lineHeight: 1.5 }}>
                    Abre un buscador interactivo para nombrar la familia y seleccionar los productos uno por uno.
                  </div>
                </div>
                <button onClick={() => setRuleBuilderOpen(true)} style={{
                  padding: "10px 20px", borderRadius: 8, border: "none",
                  background: "rgba(255,255,255,0.95)", color: C.navy, fontSize: 12, fontWeight: 700, cursor: "pointer",
                  boxShadow: "0 2px 10px rgba(0,0,0,0.15)",
                }}>➕ Crear regla</button>
              </div>

              {/* Upload + descarga plantilla */}
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>...o cargar reglas desde CSV</div>
                <div style={{ fontSize: 11, color: C.sub, marginBottom: 10, lineHeight: 1.5 }}>
                  Formato esperado (encabezado obligatorio): <code style={{ background: "#F1F5F9", padding: "2px 6px", borderRadius: 4 }}>family,upc</code> o <code style={{ background: "#F1F5F9", padding: "2px 6px", borderRadius: 4 }}>family,sku</code>. Una fila por producto.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <label style={{ padding: "8px 16px", background: `linear-gradient(135deg,${C.navy},${C.blue})`, color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                    Subir reglas
                    <input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => handleFamilyUpload(e.target.files?.[0])} />
                  </label>
                  <button onClick={() => {
                    const sample =
                      "family,upc,max_pct_change,min_margin_pct,max_margin_pct,min_price_floor,max_price_ceiling,price_above_comp_min,rounding_mode\n" +
                      "Electrolit 625,7501008071342,10,15,,,,5,ending_95\n" +
                      "Electrolit 625,7501008071343,10,15,,,,5,ending_95\n" +
                      "Electrolit 625,7501008071344,10,15,,,,5,ending_95\n" +
                      "# Columnas max_pct_change...rounding_mode son opcionales (aplican por familia; la primera fila de cada familia define las reglas)\n";
                    const blob = new Blob([sample], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = "plantilla_reglas_familia.csv"; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 14px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, fontSize: 11, color: C.sub, cursor: "pointer" }}>
                    Plantilla
                  </button>
                  {Object.keys(familyRules).length > 0 && (
                    <>
                      <button onClick={() => {
                        const rows = [["family", "sku", "upc", "max_pct_change", "min_margin_pct", "max_margin_pct", "min_price_floor", "max_price_ceiling", "price_above_comp_min", "rounding_mode"]];
                        for (const sku of Object.keys(familyRules)) {
                          const p = data.products.find(x => x.sku === sku);
                          const fam = familyRules[sku];
                          const fr = familyBusinessRules[fam] || {};
                          rows.push([
                            fam, sku, p?.upc || "",
                            fr.maxPctChange ?? "", fr.minMarginPct ?? "", fr.maxMarginPct ?? "",
                            fr.minPriceFloor ?? "", fr.maxPriceCeiling ?? "", fr.priceAboveCompMin ?? "",
                            fr.roundingMode ?? "",
                          ]);
                        }
                        const csv = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
                        const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a"); a.href = url; a.download = "reglas_familia_actual.csv"; a.click();
                        URL.revokeObjectURL(url);
                      }} style={{ padding: "8px 14px", borderRadius: 6, border: `1px solid ${C.green}`, background: "rgba(16,185,129,0.08)", color: C.green, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                        Descargar reglas actuales
                      </button>
                      <button onClick={() => { setFamilyRules({}); setFamilyBusinessRules({}); }} style={{ padding: "8px 14px", borderRadius: 6, border: `1px solid ${C.red}`, background: "rgba(239,68,68,0.08)", color: C.red, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                        Eliminar todas las reglas
                      </button>
                    </>
                  )}
                </div>
                {familyUploadMsg && <div style={{ marginTop: 10, padding: 8, background: familyUploadMsg.startsWith("✓") ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)", color: familyUploadMsg.startsWith("✓") ? C.green : C.red, borderRadius: 6, fontSize: 11 }}>{familyUploadMsg}</div>}
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
                <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: "#F8FAFC", borderBottom: `2px solid ${C.border}` }}>
                        {["Familia", "# SKUs", "Unidades (último mes)", "Precio Prom.", "Elasticidad Agregada", "Método", "MAPE", "SKUs", "Acciones"].map((h, i) => (
                          <th key={i} style={{ padding: "10px 8px", textAlign: i < 1 || i === 7 ? "left" : "center", color: C.sub, fontWeight: 600, fontSize: 9, textTransform: "uppercase" }}>{h}</th>
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
                          <tr key={f.name} style={{ borderBottom: "1px solid #F1F5F9", background: i % 2 ? "#FAFBFC" : "#fff" }}>
                            <td style={{ padding: "10px 8px", fontWeight: 700, color: C.navy }}>
                              {f.name}
                              {frLabel && <div style={{ fontSize: 9, color: C.accent, marginTop: 2, fontWeight: 500 }}>🔧 {frLabel}</div>}
                            </td>
                            <td style={{ padding: "10px 8px", textAlign: "center", fontWeight: 600 }}>{f.skus.length}</td>
                            <td style={{ padding: "10px 8px", textAlign: "center" }}>{f.totalUnits.toLocaleString()}</td>
                            <td style={{ padding: "10px 8px", textAlign: "center" }}>${f.avgPrice.toFixed(2)}</td>
                            <td style={{ padding: "10px 8px", textAlign: "center", fontWeight: 700, color: best ? (best.elasticity < -1 ? C.red : best.elasticity < 0 ? C.green : C.accent) : C.muted }}>
                              {best ? best.elasticity.toFixed(2) : "-"}
                            </td>
                            <td style={{ padding: "10px 8px", textAlign: "center" }}>{best ? <MethodBadge method={best.id} /> : "-"}</td>
                            <td style={{ padding: "10px 8px", textAlign: "center", fontSize: 10 }}>{best && best.mape < 999 ? best.mape.toFixed(1) + "%" : "-"}</td>
                            <td style={{ padding: "10px 8px", fontSize: 10, color: C.sub, maxWidth: 300 }}>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                                {f.products.slice(0, 8).map(p => (
                                  <span key={p.sku} title={p.sku_des} style={{ background: "#F1F5F9", padding: "2px 6px", borderRadius: 4, fontSize: 9 }}>
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
                              }} style={{ padding: "4px 10px", borderRadius: 5, border: `1px solid ${C.red}`, background: "rgba(239,68,68,0.08)", color: C.red, fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
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
            </div>
          );
        })()}

        {/* ── Admin › Auditoría ── */}
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

              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>Usuario actual:</span>
                <input
                  type="text"
                  value={currentUser}
                  onChange={(e) => { setCurrentUser(e.target.value); try { localStorage.setItem("elasticity_user", e.target.value); } catch { /* almacenamiento no disponible */ } }}
                  style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, minWidth: 200 }}
                />
                <div style={{ flex: 1 }} />
                <button onClick={exportAuditCSV} disabled={auditLog.length === 0} style={{ padding: "7px 14px", borderRadius: 6, border: "none", background: auditLog.length > 0 ? `linear-gradient(135deg,#059669,#10B981)` : "#CBD5E1", color: "#fff", fontSize: 11, fontWeight: 700, cursor: auditLog.length > 0 ? "pointer" : "not-allowed" }}>Exportar CSV</button>
                <button onClick={() => {
                  if (window.confirm("¿Limpiar todo el log de auditoría?")) setAuditLog([]);
                }} style={{ padding: "7px 12px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.red, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Limpiar log</button>
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
                      <div style={{ background: C.card, borderRadius: 10, padding: 16, border: `1px solid ${C.border}`, marginBottom: 14 }}>
                        <ResponsiveContainer width="100%" height={220}>
                          <ComposedChart data={timeline} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
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
                  <div style={{ background: C.card, borderRadius: 10, padding: 16, border: `1px solid ${C.border}`, marginBottom: 14 }}>
                    <ResponsiveContainer width="100%" height={Math.max(200, users.length * 40)}>
                      <BarChart data={users} layout="vertical" margin={{ top: 10, right: 10, left: 80, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis type="number" tick={{ fontSize: 9, fill: C.sub }} />
                        <YAxis type="category" dataKey="user" tick={{ fontSize: 10, fill: C.sub }} width={80} />
                        <Tooltip content={<ChartTip />} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Bar dataKey="approvals" name="Aprobaciones" stackId="a" fill={C.green} />
                        <Bar dataKey="rejections" name="Rechazos" stackId="a" fill={C.red} />
                        <Bar dataKey="overrides" name="Overrides" stackId="a" fill={C.accent} />
                        <Bar dataKey="bulk" name="Masivas" stackId="a" fill={C.blue} />
                        <Bar dataKey="rules" name="Reglas" stackId="a" fill="#7C3AED" />
                        <Bar dataKey="scenarios" name="Escenarios" stackId="a" fill={C.mid} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflowX: "auto", marginBottom: 14 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr style={{ background: "#F8FAFC", borderBottom: `2px solid ${C.border}` }}>
                          {["Usuario", "Total", "Aprobaciones", "Rechazos", "Overrides", "Masivas", "Reglas", "Escenarios"].map((h, i) => (
                            <th key={i} style={{ padding: "10px 8px", textAlign: i < 1 ? "left" : "center", fontSize: 9, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {users.map((u, i) => (
                          <tr key={u.user} style={{ borderBottom: "1px solid #F1F5F9", background: i % 2 ? "#FAFBFC" : "#fff" }}>
                            <td style={{ padding: "8px 8px", fontWeight: 600, color: C.navy }}>{u.user}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", fontWeight: 700 }}>{u.total}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: C.green }}>{u.approvals}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: C.red }}>{u.rejections}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: C.accent }}>{u.overrides}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: C.blue }}>{u.bulk}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: "#7C3AED" }}>{u.rules}</td>
                            <td style={{ padding: "8px 8px", textAlign: "center", color: C.mid }}>{u.scenarios}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Log detallado */}
                  <SectionHead ic="📜">Log Detallado (últimos 200)</SectionHead>
                  <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflowX: "auto", maxHeight: 500, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr style={{ background: "#F8FAFC", borderBottom: `2px solid ${C.border}`, position: "sticky", top: 0 }}>
                          {["Fecha/hora", "Usuario", "Acción", "SKU", "Detalle"].map((h, i) => (
                            <th key={i} style={{ padding: "10px 8px", textAlign: "left", fontSize: 9, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {auditLog.slice(0, 200).map((e, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid #F1F5F9", background: i % 2 ? "#FAFBFC" : "#fff" }}>
                            <td style={{ padding: "6px 8px", fontSize: 10, color: C.muted, whiteSpace: "nowrap" }}>{e.ts?.replace("T", " ").slice(0, 19)}</td>
                            <td style={{ padding: "6px 8px", fontSize: 10, color: C.navy, fontWeight: 600 }}>{e.user}</td>
                            <td style={{ padding: "6px 8px" }}>
                              <span style={{
                                padding: "2px 8px", borderRadius: 10, fontSize: 9, fontWeight: 700,
                                background: e.action === "APPROVE" ? "rgba(16,185,129,0.15)" : e.action === "REJECT" ? "rgba(239,68,68,0.15)" : e.action?.startsWith("BULK") ? "rgba(19,64,116,0.12)" : "rgba(124,58,237,0.12)",
                                color: e.action === "APPROVE" ? C.green : e.action === "REJECT" ? C.red : e.action?.startsWith("BULK") ? C.blue : "#7C3AED",
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

            <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>¿Qué es la elasticidad precio-demanda?</h3>
              <p style={{ fontSize: 12, color: C.sub, lineHeight: 1.7, margin: "8px 0 0" }}>
                Es una medida que indica <strong>cuánto cambia la cantidad demandada de un producto cuando cambia su precio</strong>. Matemáticamente es
                <code style={{ background: "#F1F5F9", padding: "2px 8px", borderRadius: 4, margin: "0 4px" }}>E = (%ΔQ) / (%ΔP)</code>.
                Siempre se interpreta como un <strong>número negativo</strong> (cuando el precio sube, la cantidad baja). Entre más grande en valor absoluto, más sensible es la demanda al precio.
              </p>
            </div>

            <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, padding: 18 }}>
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
                  <div key={i} style={{ padding: 12, borderRadius: 8, background: "#F8FAFC", borderLeft: `3px solid ${row.color}` }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: row.color, letterSpacing: 0.5 }}>{row.rango}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 2 }}>{row.titulo}</div>
                    <div style={{ fontSize: 11, color: C.sub, margin: "6px 0" }}>{row.desc}</div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: row.color }}>Acción sugerida: {row.accion}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>Métodos de cálculo usados</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 10 }}>
                <div style={{ padding: 14, borderRadius: 8, background: "#F0F4FF", borderTop: `3px solid ${METHOD_COLORS.ols}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: METHOD_COLORS.ols }}>OLS Lineal</div>
                  <div style={{ fontSize: 11, color: C.sub, margin: "6px 0" }}>Modelo: <code>Q = a + b·P</code>. La elasticidad se deriva como <code>E = b × (P̄/Q̄)</code>.</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 8 }}><strong>Cuándo usarlo:</strong> cuando la relación precio-demanda se ve aproximadamente lineal en el gráfico. Útil cuando los precios cambian poco.</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 4 }}><strong>Limitación:</strong> la elasticidad depende del nivel de precio y cantidad promedio; no captura cambios porcentuales grandes.</div>
                </div>
                <div style={{ padding: 14, borderRadius: 8, background: "#F5F0FF", borderTop: `3px solid ${METHOD_COLORS.loglog}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: METHOD_COLORS.loglog }}>Log-Log</div>
                  <div style={{ fontSize: 11, color: C.sub, margin: "6px 0" }}>Modelo: <code>ln(Q) = a + b·ln(P)</code>. El coeficiente <code>b</code> ES directamente la elasticidad.</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 8 }}><strong>Cuándo usarlo:</strong> es el método más robusto para la mayoría de productos. Asume elasticidad constante, lo que suele ajustarse bien a datos reales.</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 4 }}><strong>Limitación:</strong> requiere precios y unidades positivas (no cero).</div>
                </div>
                <div style={{ padding: 14, borderRadius: 8, background: "#FFFBEB", borderTop: `3px solid ${METHOD_COLORS.arc}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: METHOD_COLORS.arc }}>Arco Mid-Point</div>
                  <div style={{ fontSize: 11, color: C.sub, margin: "6px 0" }}>Calcula <code>E = (ΔQ/ΔP) × ((P₁+P₂)/(Q₁+Q₂))</code> entre cada par consecutivo y promedia.</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 8 }}><strong>Cuándo usarlo:</strong> cuando hay pocos datos históricos o cuando ocurren <strong>cambios grandes y puntuales</strong> de precio (ej. promociones).</div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 4 }}><strong>Limitación:</strong> sensible a outliers; si dos meses tienen el mismo precio, ese par no aporta.</div>
                </div>
              </div>
            </div>

            <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>Métricas de error</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, marginTop: 10 }}>
                {[
                  { k: "MAPE", n: "Mean Absolute Percentage Error", d: "Promedio del error porcentual absoluto entre predicción y realidad. Es el criterio principal para elegir el mejor método. <30% = excelente, 30-60% = aceptable, >60% = débil." },
                  { k: "RMSE", n: "Root Mean Squared Error", d: "Raíz del error cuadrático medio. Penaliza más los errores grandes. Útil para comparar entre métodos pero difícil de interpretar en términos absolutos." },
                  { k: "MAE", n: "Mean Absolute Error", d: "Error absoluto medio (en unidades). Fácil de interpretar: en promedio la predicción se desvía X unidades." },
                  { k: "R²", n: "Coeficiente de determinación", d: "% de la varianza de la demanda que explica el modelo. 1.0 es perfecto, 0 es igual a usar el promedio. Sólo se calcula para OLS y Log-Log." },
                ].map((m, i) => (
                  <div key={i} style={{ padding: 12, borderRadius: 8, background: "#F8FAFC" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.navy }}>{m.k} <span style={{ fontSize: 10, fontWeight: 400, color: C.sub }}>— {m.n}</span></div>
                    <div style={{ fontSize: 11, color: C.sub, marginTop: 4, lineHeight: 1.5 }}>{m.d}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>Fórmulas de precio óptimo</h3>
              <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.7, marginTop: 8 }}>
                <p><strong>{"Caso elástico (|E| > 1):"}</strong> el precio que maximiza el ingreso es <code style={{ background: "#F1F5F9", padding: "2px 6px", borderRadius: 4 }}>P* = P_actual / (1 + 1/E)</code>. Esta es la condición de Lerner.</p>
                <p><strong>{"Caso inelástico (|E| ≤ 1):"}</strong> matemáticamente el ingreso sigue creciendo con cualquier subida, así que la práctica común es sugerir subidas moderadas (5%) y cuidar no exceder precios de referencia.</p>
                <p><strong>Restricciones aplicadas:</strong> el sugerido se acota a ±30% del precio actual y a un mínimo del costo × 1.02 (si hay dato de margen).</p>
              </div>
            </div>

            <div style={{ background: "#F0FDF4", border: `1px solid #86EFAC`, borderLeft: `4px solid ${C.green}`, borderRadius: 12, padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>⚙️ Cómo trabaja el optimizador de este dashboard</h3>
              <div style={{ fontSize: 11, color: C.text, lineHeight: 1.7, marginTop: 8 }}>
                <p>
                  <strong>Búsqueda numérica del óptimo:</strong> el optimizador busca numéricamente dentro del rango ±30% el precio que maximiza
                  <code style={{ background: "#DCFCE7", padding: "2px 6px", borderRadius: 4, margin: "0 4px" }}>P·Q(P)</code>
                  bajo
                  <code style={{ background: "#DCFCE7", padding: "2px 6px", borderRadius: 4, margin: "0 4px" }}>Q = Q₀·(P/P₀)^E</code>.
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

            <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, padding: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: C.navy }}>Comparativa rápida: cuándo elegir cada método</h3>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginTop: 10 }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
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
                    <tr key={i} style={{ borderTop: "1px solid #F1F5F9" }}>
                      <td style={{ padding: 8, color: C.text }}>{row[0]}</td>
                      <td style={{ padding: 8, color: C.navy, fontWeight: 700 }}>{row[1]}</td>
                      <td style={{ padding: 8, color: C.sub }}>{row[2]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ background: "#EFF6FF", border: `1px solid #BFDBFE`, borderRadius: 12, padding: 18 }}>
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
    </div>
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

    if (familyName) {
      // El análisis viene AGREGADO de la familia: sus arreglos `predicted` están en la
      // escala de unidades de toda la familia, no de este SKU. Reconstruimos la predicción
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
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(11,37,69,0.55)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "24px 16px", overflowY: "auto" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.bg, borderRadius: 14, maxWidth: 1000, width: "100%", padding: "18px 20px 24px", boxShadow: "0 24px 70px rgba(0,0,0,0.35)", position: "relative" }}>
        <button onClick={onClose} title="Cerrar (Esc)" style={{ position: "absolute", top: 12, right: 12, zIndex: 3, width: 30, height: 30, borderRadius: 8, border: "none", background: "rgba(15,23,42,0.45)", color: "#fff", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        {!hasAnalysis ? (
          <div style={{ textAlign: "center", padding: 60, color: C.sub }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📊</div>
            <div style={{ fontSize: 14 }}>No hay suficiente información para calcular la elasticidad de este producto.</div>
          </div>
        ) : (
          <>
            {/* Product header */}
            {(() => {
              const selComp = compData;
              const interp = activeMethod ? interpretElasticity(activeMethod.elasticity) : null;
              return (
                <div style={{ background: `linear-gradient(135deg,${C.navy},${C.blue})`, borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: "0 4px 16px rgba(11,37,69,0.2)", display: "flex", gap: 16 }}>
                  <div style={{ width: 110, height: 110, flexShrink: 0, background: "rgba(255,255,255,0.08)", borderRadius: 10, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(255,255,255,0.1)" }}>
                    {selComp?.image ? (
                      <img src={selComp.image} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", background: "#fff" }} onError={e => { e.target.style.display = "none"; }} />
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
                      <div style={{ marginTop: 4, display: "inline-block", background: "rgba(245,158,11,0.18)", color: "#FDE68A", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>
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
                          <div style={{ fontSize: 22, fontWeight: 800, color: activeMethod.elasticity < -1 ? "#F87171" : activeMethod.elasticity < 0 ? "#6EE7B7" : C.accent }}>{activeMethod.elasticity.toFixed(3)}</div>
                          {interp && (
                            <div style={{ fontSize: 10, fontWeight: 700, color: "#FDE68A", marginTop: 2 }}>
                              {interp.label}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {interp && (
                      <div style={{ marginTop: 10, padding: "8px 10px", background: "rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 10, color: "rgba(255,255,255,0.85)", lineHeight: 1.5 }}>
                        <strong style={{ color: "#FDE68A" }}>¿Qué significa?</strong> {interp.explanation}
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
                background: selMethod === null ? "rgba(16,185,129,0.08)" : C.card, cursor: "pointer", fontSize: 11, fontWeight: 600,
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
                    boxShadow: isActive ? `0 2px 12px ${METHOD_COLORS[r.id]}22` : "0 1px 3px rgba(0,0,0,0.04)",
                    position: "relative",
                  }}>
                    {isBest && (
                      <div style={{ position: "absolute", top: -8, right: 10, background: C.green, color: "#fff", fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>
                        RECOMENDADO
                      </div>
                    )}
                    <div style={{ fontSize: 12, fontWeight: 700, color: METHOD_COLORS[r.id], marginBottom: 8 }}>{r.method}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 11 }}>
                      <div><span style={{ color: C.sub }}>Elasticidad:</span></div>
                      <div style={{ fontWeight: 700, textAlign: "right" }}>{r.elasticity.toFixed(3)}</div>
                      {r.r2 !== null && <><div><span style={{ color: C.sub }}>R²:</span></div><div style={{ fontWeight: 600, textAlign: "right" }}>{r.r2.toFixed(4)}</div></>}
                      <div><span style={{ color: C.sub }}>RMSE:</span></div>
                      <div style={{ fontWeight: 600, textAlign: "right" }}>{r.rmse.toLocaleString()}</div>
                      <div><span style={{ color: C.sub }}>MAE:</span></div>
                      <div style={{ fontWeight: 600, textAlign: "right" }}>{r.mae.toLocaleString()}</div>
                      <div><span style={{ color: C.sub }}>MAPE:</span></div>
                      <div style={{ fontWeight: 600, textAlign: "right", color: r.mape < 30 ? C.green : r.mape < 60 ? C.accent : C.red }}>{r.mape < 999 ? r.mape.toFixed(1) + "%" : "N/A"}</div>
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
                  <div style={{ background: "linear-gradient(135deg,#059669,#10B981)", borderRadius: 12, padding: 18, display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", marginBottom: 10, boxShadow: "0 4px 16px rgba(5,150,105,0.2)" }}>
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
                        <div style={{ fontSize: 16, fontWeight: 700, color: sug.pctChange > 0 ? "#BBF7D0" : "#FCA5A5" }}>
                          {sug.pctChange > 0 ? "+" : ""}{sug.pctChange}%
                        </div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)" }}>TIPO</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#FDE68A" }}>
                          {Math.abs(activeMethod.elasticity) > 1 ? "Elastico" : "Inelastico"}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Reasoning note */}
                  <div style={{ background: "#FFFBEB", border: `1px solid ${C.accent}55`, borderLeft: `4px solid ${C.accent}`, borderRadius: 8, padding: "12px 14px", marginBottom: 14, fontSize: 11, color: C.text, lineHeight: 1.55 }}>
                    <div style={{ fontWeight: 700, color: C.navy, marginBottom: 4, fontSize: 11 }}>
                      {sug.pctChange > 0.5 ? "⬆️ Razón para subir:" : sug.pctChange < -0.5 ? "⬇️ Razón para bajar:" : "➡️ Razón para mantener:"}
                    </div>
                    {note}
                  </div>

                  {/* Competitor prices */}
                  {selComp && selComp.competitors?.length > 0 && (
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.navy }}>🏪 Precios de la Competencia</div>
                        <div style={{ fontSize: 10, color: C.sub }}>UPC: {selComp.upc}</div>
                      </div>
                      <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                        <div style={{ padding: "6px 10px", background: "rgba(16,185,129,0.08)", borderRadius: 6, fontSize: 11 }}>
                          <span style={{ color: C.sub }}>Mín: </span><strong style={{ color: C.green }}>${selComp.minPrice?.toLocaleString("es-MX")}</strong>
                        </div>
                        <div style={{ padding: "6px 10px", background: "rgba(19,64,116,0.08)", borderRadius: 6, fontSize: 11 }}>
                          <span style={{ color: C.sub }}>Prom: </span><strong style={{ color: C.blue }}>${selComp.avgPrice?.toLocaleString("es-MX")}</strong>
                        </div>
                        <div style={{ padding: "6px 10px", background: "rgba(239,68,68,0.08)", borderRadius: 6, fontSize: 11 }}>
                          <span style={{ color: C.sub }}>Máx: </span><strong style={{ color: C.red }}>${selComp.maxPrice?.toLocaleString("es-MX")}</strong>
                        </div>
                        <div style={{ padding: "6px 10px", background: "rgba(245,158,11,0.08)", borderRadius: 6, fontSize: 11 }}>
                          <span style={{ color: C.sub }}>Tu precio: </span><strong style={{ color: C.accent }}>${lastMonth.price.toLocaleString("es-MX")}</strong>
                        </div>
                        <div style={{ padding: "6px 10px", background: "#EEF2FF", borderRadius: 6, fontSize: 11 }}>
                          <span style={{ color: C.sub }}>Sugerido vs Mín: </span>
                          <strong style={{ color: sug.suggestedPrice > selComp.minPrice ? C.red : C.green }}>
                            {(((sug.suggestedPrice - selComp.minPrice) / selComp.minPrice) * 100).toFixed(1)}%
                          </strong>
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px,1fr))", gap: 6 }}>
                        {selComp.competitors.slice(0, 12).map((c, i) => (
                          <div key={i} style={{ padding: "6px 8px", background: "#F8FAFC", borderRadius: 6, fontSize: 10, display: "flex", justifyContent: "space-between", gap: 6 }}>
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
                  <div style={{ background: C.card, borderRadius: 10, padding: 16, border: `1px solid ${C.border}`, marginBottom: 14 }}>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10, fontSize: 11 }}>
                      <div style={{ padding: "6px 10px", background: "rgba(19,64,116,0.08)", borderRadius: 6 }}>
                        <span style={{ color: C.sub }}>Venta histórica 6m: </span><strong style={{ color: C.blue }}>${totalHistRev.toLocaleString("es-MX")}</strong>
                      </div>
                      <div style={{ padding: "6px 10px", background: "rgba(16,185,129,0.08)", borderRadius: 6 }}>
                        <span style={{ color: C.sub }}>Venta forecast 6m: </span><strong style={{ color: C.green }}>${totalFcstRev.toLocaleString("es-MX")}</strong>
                      </div>
                      {sug && (
                        <div style={{ padding: "6px 10px", background: "rgba(245,158,11,0.08)", borderRadius: 6 }}>
                          <span style={{ color: C.sub }}>Precio objetivo forecast: </span><strong style={{ color: C.accent }}>${sug.suggestedPrice}</strong>
                          {" "}(desde ${lastMonth.price})
                        </div>
                      )}
                    </div>
                    <ResponsiveContainer width="100%" height={280}>
                      <ComposedChart data={combo} margin={{ top: 10, right: 10, left: -5, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="month" tick={{ fontSize: 9, fill: C.sub }} />
                        <YAxis yAxisId="left" tick={{ fontSize: 9, fill: C.sub }} tickFormatter={v => "$" + v.toLocaleString()} />
                        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9, fill: C.sub }} />
                        <Tooltip content={<ChartTip />} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Bar yAxisId="right" dataKey="unidadesHist" name="Unidades (hist.)" fill={C.mid} opacity={0.35} radius={[2, 2, 0, 0]} />
                        <Bar yAxisId="right" dataKey="unidadesF" name="Unidades (forecast ≈ prom. 6m × elasticidad)" fill="#FDE68A" opacity={0.85} stroke={C.accent} radius={[2, 2, 0, 0]} />
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
                        <div style={{ background: C.card, borderRadius: 10, padding: 16, border: `1px solid ${C.border}`, marginBottom: 14 }}>
                          <div style={{ fontSize: 11, color: C.sub, marginBottom: 10, lineHeight: 1.5 }}>
                            La curva usa un <strong>modelo lineal local</strong> calibrado al precio y unidades actuales y a la elasticidad estimada. Este modelo captura la intuición de que si bajas demasiado el precio, aunque vendas más unidades, el <strong>ingreso total cae</strong> porque el precio unitario se reduce más rápido de lo que crece el volumen. La línea <span style={{ color: C.accent, fontWeight: 700 }}>⭐ sweet spot</span> marca el precio donde la <em>venta total ($)</em> es máxima.
                          </div>
                          <ResponsiveContainer width="100%" height={280}>
                            <ComposedChart data={scenarios} margin={{ top: 10, right: 10, left: -5, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                              <XAxis dataKey="label" tick={{ fontSize: 10, fill: C.sub }} label={{ value: "Cambio de precio vs actual", position: "insideBottom", offset: -5, fontSize: 10, fill: C.sub }} />
                              <YAxis tick={{ fontSize: 9, fill: C.sub }} tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} />
                              <Tooltip content={<ChartTip />} />
                              <Legend wrapperStyle={{ fontSize: 10 }} />
                              <Area type="monotone" dataKey="revenue" name="Venta proyectada ($)" fill={C.light} stroke={C.blue} strokeWidth={2} fillOpacity={0.25} />
                              <Line type="monotone" dataKey="units" name="Unidades vendidas" stroke={C.green} strokeWidth={1.5} strokeDasharray="3 3" dot={false} yAxisId="left" />
                            </ComposedChart>
                          </ResponsiveContainer>

                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginTop: 14 }}>
                            <div style={{ padding: 10, borderRadius: 8, background: "rgba(19,64,116,0.06)", borderLeft: `3px solid ${C.blue}` }}>
                              <div style={{ fontSize: 9, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>Precio actual (0%)</div>
                              <div style={{ fontSize: 14, fontWeight: 700, color: C.blue }}>${P0} → ${Math.round(currentRev).toLocaleString()}</div>
                            </div>
                            <div style={{ padding: 10, borderRadius: 8, background: "rgba(245,158,11,0.12)", borderLeft: `3px solid ${C.accent}` }}>
                              <div style={{ fontSize: 9, color: C.accent, fontWeight: 700, textTransform: "uppercase" }}>⭐ Sweet spot (máx. ingreso)</div>
                              <div style={{ fontSize: 14, fontWeight: 700, color: C.accent }}>${sweet.toFixed(2)} ({sweetPct > 0 ? "+" : ""}{sweetPct.toFixed(1)}%) → ${Math.round(sweetRev).toLocaleString()}</div>
                            </div>
                            {sug && (
                              <div style={{ padding: 10, borderRadius: 8, background: "rgba(16,185,129,0.08)", borderLeft: `3px solid ${C.green}` }}>
                                <div style={{ fontSize: 9, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>Sugerido por optimizador ({sug.pctChange > 0 ? "+" : ""}{sug.pctChange}%)</div>
                                <div style={{ fontSize: 14, fontWeight: 700, color: C.green }}>${sug.suggestedPrice} → ${Math.round(sugRev).toLocaleString()}</div>
                              </div>
                            )}
                          </div>

                          <div style={{ marginTop: 12, padding: "10px 12px", background: "#FFFBEB", borderLeft: `4px solid ${C.accent}`, borderRadius: 6, fontSize: 11, color: C.text, lineHeight: 1.55 }}>
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
            <div style={{ background: C.card, borderRadius: 10, padding: 16, border: `1px solid ${C.border}`, marginBottom: 14 }}>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={chartData} margin={{ top: 10, right: 10, left: -5, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
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
            <div style={{ background: C.card, borderRadius: 10, padding: 16, border: `1px solid ${C.border}` }}>
              <ResponsiveContainer width="100%" height={220}>
                <ScatterChart margin={{ top: 10, right: 10, left: -5, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
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
      style={{ position: "fixed", inset: 0, background: "rgba(11,37,69,0.6)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, borderRadius: 12, maxWidth: 900, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.3)", overflow: "hidden" }}>
        <div style={{ padding: 18, borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.navy }}>➕ Nueva regla de familia</div>
          <button onClick={onClose} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, cursor: "pointer", fontSize: 12, fontWeight: 600, color: C.sub }}>Cerrar ✕</button>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14, overflow: "hidden", flex: 1 }}>
          <div>
            <label style={{ fontSize: 11, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>Nombre de la familia</label>
            <input
              type="text" value={familyName} onChange={(e) => setFamilyName(e.target.value)}
              placeholder='ej. "Electrolit 625"'
              style={{ width: "100%", padding: "10px 14px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, marginTop: 4, outline: "none" }}
            />
          </div>

          <div>
            <label style={{ fontSize: 11, color: C.sub, fontWeight: 600, textTransform: "uppercase" }}>Buscar productos (nombre, SKU, brand o UPC)</label>
            <input
              type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Empieza a escribir para buscar..."
              style={{ width: "100%", padding: "10px 14px", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, marginTop: 4, outline: "none" }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, flex: 1, minHeight: 0 }}>
            {/* Resultados de búsqueda */}
            <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ fontSize: 10, color: C.sub, fontWeight: 600, textTransform: "uppercase", marginBottom: 6 }}>Resultados {results.length > 0 && `(${results.length})`}</div>
              <div style={{ flex: 1, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 8, background: "#FAFBFC" }}>
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
                        style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, background: isSel ? "rgba(16,185,129,0.08)" : "transparent" }}>
                        <div style={{ width: 22, height: 22, background: "#fff", border: `2px solid ${isSel ? C.green : C.border}`, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          {isSel && <span style={{ color: C.green, fontWeight: 700, fontSize: 14 }}>✓</span>}
                        </div>
                        <div style={{ width: 28, height: 28, background: "#F1F5F9", borderRadius: 4, overflow: "hidden", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
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
              <div style={{ flex: 1, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 8, background: "#FAFBFC" }}>
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
                          style={{ padding: "2px 8px", background: "rgba(239,68,68,0.1)", border: "none", color: C.red, borderRadius: 4, cursor: "pointer", fontSize: 10 }}>✕</button>
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
          <button onClick={() => setShowRules(s => !s)} style={{ padding: "8px 12px", border: `1px solid ${C.border}`, background: showRules ? C.card : "#F8FAFC", borderRadius: 6, fontSize: 11, fontWeight: 600, color: C.navy, cursor: "pointer", width: "100%", textAlign: "left" }}>
            {showRules ? "▼" : "▶"} Reglas de negocio específicas para esta familia (opcional)
          </button>
          {showRules && (
            <div style={{ padding: 14, border: `1px dashed ${C.border}`, borderRadius: 6, marginTop: 8, background: "#FAFBFC" }}>
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
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Margen mín. %</label>
                  <input type="number" step="1" min="0" max="100"
                    value={rules.minMarginPct ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, minMarginPct: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                    placeholder="ej. 15"
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Margen máx. %</label>
                  <input type="number" step="1" min="0" max="100"
                    value={rules.maxMarginPct ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, maxMarginPct: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                    placeholder="ej. 60"
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Piso ($)</label>
                  <input type="number" step="0.01" min="0"
                    value={rules.minPriceFloor ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, minPriceFloor: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                    placeholder="0"
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Techo ($)</label>
                  <input type="number" step="0.01" min="0"
                    value={rules.maxPriceCeiling ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, maxPriceCeiling: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                    placeholder="sin límite"
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Max % vs comp. mín.</label>
                  <input type="number" step="1"
                    value={rules.priceAboveCompMin ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, priceAboveCompMin: e.target.value === "" ? null : parseFloat(e.target.value) }))}
                    placeholder="ej. 5"
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 9, color: C.sub, fontWeight: 700, textTransform: "uppercase" }}>Redondeo</label>
                  <select
                    value={rules.roundingMode ?? ""}
                    onChange={(e) => setRules(r => ({ ...r, roundingMode: e.target.value || null }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, marginTop: 4 }}
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

        <div style={{ padding: 14, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", background: "#F8FAFC" }}>
          <div style={{ fontSize: 11, color: C.sub }}>
            {canSave ? `✓ Listo: "${familyName}" con ${selectedSkus.length} productos` : "Completa el nombre y selecciona al menos 1 producto"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.card, fontSize: 12, color: C.sub, cursor: "pointer" }}>Cancelar</button>
            <button disabled={!canSave}
              onClick={() => onSave(familyName.trim(), selectedSkus, cleanRules())}
              style={{
                padding: "9px 18px", borderRadius: 8, border: "none",
                background: canSave ? `linear-gradient(135deg,${C.navy},${C.blue})` : "#CBD5E1",
                color: "#fff", fontSize: 12, fontWeight: 700, cursor: canSave ? "pointer" : "not-allowed",
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
      style={{ position: "fixed", inset: 0, background: "rgba(11,37,69,0.6)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, borderRadius: 12, maxWidth: 1100, width: "100%", maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ padding: 18, borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: C.sub, textTransform: "uppercase", fontWeight: 700 }}>Cluster</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.navy }}>
              <span style={{ padding: "2px 10px", borderRadius: 12, background: abcColor[clusterPopup.abc] + "22", color: abcColor[clusterPopup.abc], fontWeight: 700, fontSize: 14, marginRight: 8 }}>{clusterPopup.abc}</span>
              {clusterPopup.sub}
            </div>
            <div style={{ fontSize: 11, color: C.sub, marginTop: 4 }}>{rows.length} productos · Acción sugerida: <strong style={{ color: C.text }}>{clusterPopup.action}</strong></div>
          </div>
          <button onClick={onClose} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, cursor: "pointer", fontSize: 12, fontWeight: 600, color: C.sub }}>Cerrar ✕</button>
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "#F8FAFC", borderBottom: `2px solid ${C.border}`, position: "sticky", top: 0 }}>
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
                <tr key={p.sku} style={{ borderBottom: "1px solid #F1F5F9", background: i % 2 ? "#FAFBFC" : "#fff", cursor: "pointer" }}
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
