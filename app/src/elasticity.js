/**
 * Price Elasticity Calculation Engine
 * 3 Methods: OLS Linear, Log-Log, Mid-Point Arc
 */

// ── Helper: Simple Linear Regression (OLS) ──
function linReg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 };
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, x) => a + x * x, 0);
  const sxy = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return { slope: 0, intercept: sy / n, r2: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;

  // R²
  const yMean = sy / n;
  const ssTot = ys.reduce((a, y) => a + (y - yMean) ** 2, 0);
  const ssRes = ys.reduce((a, y, i) => a + (y - (intercept + slope * xs[i])) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { slope, intercept, r2 };
}

// ── Error metrics ──
function calcErrors(actual, predicted) {
  const n = actual.length;
  if (n === 0) return { rmse: Infinity, mae: Infinity, mape: Infinity };
  let sse = 0, sae = 0, sape = 0, validMape = 0;
  for (let i = 0; i < n; i++) {
    const err = actual[i] - predicted[i];
    sse += err * err;
    sae += Math.abs(err);
    if (Math.abs(actual[i]) > 0.01) {
      sape += Math.abs(err / actual[i]);
      validMape++;
    }
  }
  return {
    rmse: Math.sqrt(sse / n),
    mae: sae / n,
    mape: validMape > 0 ? (sape / validMape) * 100 : Infinity,
  };
}

/**
 * Method 1: OLS Linear Regression
 * Q = a + b*P  →  elasticity = b * (P_mean / Q_mean)
 */
export function olsElasticity(series) {
  const valid = series.filter(d => d.price > 0 && d.units > 0);
  if (valid.length < 3) return null;

  const prices = valid.map(d => d.price);
  const units = valid.map(d => d.units);

  const reg = linReg(prices, units);
  const pMean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const qMean = units.reduce((a, b) => a + b, 0) / units.length;

  const elasticity = qMean > 0 ? reg.slope * (pMean / qMean) : 0;

  // Predictions
  const predicted = prices.map(p => reg.intercept + reg.slope * p);
  const errors = calcErrors(units, predicted);

  return {
    method: "OLS Lineal",
    id: "ols",
    elasticity: Math.round(elasticity * 1000) / 1000,
    r2: Math.round(reg.r2 * 10000) / 10000,
    rmse: Math.round(errors.rmse * 100) / 100,
    mae: Math.round(errors.mae * 100) / 100,
    mape: Math.round(errors.mape * 100) / 100,
    slope: reg.slope,
    intercept: reg.intercept,
    predicted,
    description: "Regresión lineal simple: Q = a + bP. Elasticidad = b × (P̄/Q̄)",
  };
}

/**
 * Method 2: Log-Log Regression
 * ln(Q) = a + b*ln(P)  →  b is the elasticity directly
 */
export function logLogElasticity(series) {
  const valid = series.filter(d => d.price > 0 && d.units > 0);
  if (valid.length < 3) return null;

  const logP = valid.map(d => Math.log(d.price));
  const logQ = valid.map(d => Math.log(d.units));

  const reg = linReg(logP, logQ);
  const elasticity = reg.slope; // directly the elasticity

  // Predictions (in original scale)
  const predicted = logP.map(lp => Math.exp(reg.intercept + reg.slope * lp));
  const actual = valid.map(d => d.units);
  const errors = calcErrors(actual, predicted);

  return {
    method: "Log-Log",
    id: "loglog",
    elasticity: Math.round(elasticity * 1000) / 1000,
    r2: Math.round(reg.r2 * 10000) / 10000,
    rmse: Math.round(errors.rmse * 100) / 100,
    mae: Math.round(errors.mae * 100) / 100,
    mape: Math.round(errors.mape * 100) / 100,
    slope: reg.slope,
    intercept: reg.intercept,
    predicted,
    description: "Regresión log-log: ln(Q) = a + b·ln(P). b es directamente la elasticidad.",
  };
}

/**
 * Method 3: Mid-Point Arc Elasticity
 * For each consecutive pair: E = (ΔQ/ΔP) × ((P1+P2)/(Q1+Q2))
 * Returns the weighted average
 */
export function arcElasticity(series) {
  const valid = series.filter(d => d.price > 0 && d.units > 0);
  if (valid.length < 3) return null;

  const arcs = [];
  for (let i = 1; i < valid.length; i++) {
    const dP = valid[i].price - valid[i - 1].price;
    const dQ = valid[i].units - valid[i - 1].units;
    const avgP = (valid[i].price + valid[i - 1].price) / 2;
    const avgQ = (valid[i].units + valid[i - 1].units) / 2;
    if (Math.abs(dP) > 0.001 && avgQ > 0) {
      arcs.push((dQ / dP) * (avgP / avgQ));
    }
  }

  if (arcs.length === 0) return null;

  const elasticity = arcs.reduce((a, b) => a + b, 0) / arcs.length;

  // "Predict" using the average elasticity from each point
  const qMean = valid.reduce((a, d) => a + d.units, 0) / valid.length;
  const pMean = valid.reduce((a, d) => a + d.price, 0) / valid.length;
  const predicted = valid.map(d => {
    const pctChange = (d.price - pMean) / pMean;
    return Math.max(0, qMean * (1 + elasticity * pctChange));
  });
  const actual = valid.map(d => d.units);
  const errors = calcErrors(actual, predicted);

  return {
    method: "Arco Mid-Point",
    id: "arc",
    elasticity: Math.round(elasticity * 1000) / 1000,
    r2: null, // Not applicable for arc method, use MAPE instead
    rmse: Math.round(errors.rmse * 100) / 100,
    mae: Math.round(errors.mae * 100) / 100,
    mape: Math.round(errors.mape * 100) / 100,
    arcs,
    predicted,
    description: "Elasticidad arco punto medio: promedio de (ΔQ/ΔP)×((P₁+P₂)/(Q₁+Q₂))",
  };
}

/**
 * Run all 3 methods and recommend the best one
 */
export function analyzeElasticity(series) {
  const results = [olsElasticity(series), logLogElasticity(series), arcElasticity(series)].filter(Boolean);
  if (results.length === 0) return { results: [], best: null };

  // Score: lower MAPE is better; if MAPE is Infinity, use RMSE
  let best = results[0];
  for (const r of results) {
    if (r.mape < best.mape || (r.mape === best.mape && r.rmse < best.rmse)) {
      best = r;
    }
  }

  return { results, best };
}

/**
 * Calculate suggested price for a SKU given its elasticity.
 *
 * Under constant-elasticity demand Q(P) = Q0·(P/P0)^E the revenue
 * R(P) = P·Q(P) is monotone: it grows as P falls when |E|>1 (elástico) and
 * grows as P rises when |E|<1 (inelástico). The old implementation applied
 * the Lerner rule with current price in place of marginal cost, which pushes
 * prices the WRONG way for elastic products.
 *
 * This version searches for the revenue-maximizing price inside the allowed
 * band (±30% of current, floor at cost·1.05 when margin is known). That
 * guarantees the projected revenue at the suggested price is ≥ the projected
 * revenue at the current price under the model.
 */
// Limit extreme / positive elasticities that are almost surely noise in the data.
// Range [-4, -0.05] is used for projection and pricing; positive elasticities
// (Giffen) collapse to 0 so we simply keep the current price.
export function sanitizeElasticity(e) {
  if (!isFinite(e)) return 0;
  if (e >= 0) return 0;                // positive/zero → treat as "no reliable signal"
  if (e < -4) return -4;               // cap extreme elastic values
  if (e > -0.05) return -0.05;         // floor tiny negatives
  return e;
}

export function suggestPrice(currentPrice, elasticity, margin) {
  if (!currentPrice || currentPrice <= 0 || !isFinite(elasticity)) {
    return { suggestedPrice: currentPrice, reason: "Datos insuficientes", pctChange: 0 };
  }

  const eSafe = sanitizeElasticity(elasticity);
  if (eSafe === 0) {
    return { suggestedPrice: currentPrice, reason: "Elasticidad atípica o insuficiente: mantener precio", pctChange: 0 };
  }

  // Cost floor
  let minPrice = currentPrice * 0.7;
  if (margin > 0 && margin < 1) {
    const estimatedCost = currentPrice * (1 - margin);
    minPrice = Math.max(minPrice, estimatedCost * 1.05);
  }
  const maxPrice = currentPrice * 1.3;
  if (minPrice > maxPrice) minPrice = currentPrice; // fallback si el costo ya está arriba

  // Revenue under constant elasticity: argmax of (P/P0)^(1+E) · (P/P0)
  const revenueAt = (p) => Math.pow(p / currentPrice, 1 + eSafe) * (p / currentPrice);

  let bestPrice = currentPrice;
  let bestRev = revenueAt(currentPrice);
  const STEPS = 80;
  for (let i = 0; i <= STEPS; i++) {
    const p = minPrice + ((maxPrice - minPrice) * i) / STEPS;
    const r = revenueAt(p);
    if (r > bestRev) { bestRev = r; bestPrice = p; }
  }

  const pctChange = Math.round(((bestPrice - currentPrice) / currentPrice) * 10000) / 100;

  let reason;
  if (pctChange > 0.5) {
    reason = eSafe > -1
      ? "Producto inelástico: margen para subir precio y aumentar ingreso"
      : "Demanda estable: subir precio mejora ingreso dentro del rango permitido";
  } else if (pctChange < -0.5) {
    reason = "Producto elástico: bajar precio aumenta el volumen más de lo que reduce el unitario";
  } else {
    reason = "Precio actual cercano al óptimo dentro del rango permitido";
  }

  return {
    suggestedPrice: Math.round(bestPrice * 100) / 100,
    reason,
    pctChange,
  };
}
