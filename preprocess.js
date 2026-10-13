/**
 * Pre-process sales_data_fesa.csv → public/data.json
 * Aggregates weekly rows into monthly SKU-level data for the React dashboard.
 */
const fs = require("fs");
const path = require("path");

const CSV_PATH = path.join(__dirname, "sales_data_fesa.csv");
const OUT_PATH = path.join(__dirname, "app", "public", "data.json");

console.time("preprocess");

const raw = fs.readFileSync(CSV_PATH, "utf-8");
const lines = raw.split("\n");
const header = lines[0].replace(/^\uFEFF/, "").split(",");

const col = {};
header.forEach((h, i) => (col[h.trim()] = i));

// Parse helper - handles quoted fields simply
function getField(parts, name) {
  const idx = col[name];
  return idx !== undefined ? (parts[idx] || "").trim().replace(/^"|"$/g, "") : "";
}

// ── Pass 1: aggregate by sku + year_month ──
const skuMonth = {};   // key = "sku|year_month"
const skuMeta = {};    // sku -> metadata (from last row seen)

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line || line.trim() === "") continue;

  // Simple CSV split (handles most cases; the data is mostly numeric)
  const parts = line.split(",");

  const sku = getField(parts, "sku");
  const ym = getField(parts, "year_month");
  const sales = parseFloat(getField(parts, "unit_sales")) || 0;
  const price = parseFloat(getField(parts, "price")) || 0;
  const margin = parseFloat(getField(parts, "margin")) || 0;

  if (!sku || !ym || sales <= 0) continue;

  const key = sku + "|" + ym;
  if (!skuMonth[key]) {
    skuMonth[key] = { totalSales: 0, priceSum: 0, priceCount: 0, marginSum: 0, marginCount: 0 };
  }
  const rec = skuMonth[key];
  rec.totalSales += sales;
  if (price > 0) {
    rec.priceSum += price * sales;  // weighted price
    rec.priceCount += sales;
  }
  if (margin > 0) {
    rec.marginSum += margin * sales;
    rec.marginCount += sales;
  }

  // Store metadata (last seen wins, fine for stable attributes)
  if (!skuMeta[sku]) {
    skuMeta[sku] = {
      sku,
      sku_des: getField(parts, "sku_des"),
      department: getField(parts, "department"),
      subcategory: getField(parts, "subcategory"),
      category: getField(parts, "category"),
      brand: getField(parts, "brand"),
      supplier: getField(parts, "supplier"),
      upc: getField(parts, "upc"),
      active_ingredient: getField(parts, "active_ingredient"),
      molecule: getField(parts, "molecule"),
      fesa_classification: getField(parts, "fesa_classification"),
    };
  }
}

console.log(`Parsed ${Object.keys(skuMonth).length} sku-month combos, ${Object.keys(skuMeta).length} unique SKUs`);

// ── Pass 2: build per-SKU time series ──
// Sort months chronologically
const allMonths = [...new Set(Object.keys(skuMonth).map(k => k.split("|")[1]))].sort();
console.log("Months:", allMonths);

const products = [];
for (const sku of Object.keys(skuMeta)) {
  const series = [];
  let hasVariation = false;
  let prevPrice = null;

  for (const ym of allMonths) {
    const rec = skuMonth[sku + "|" + ym];
    if (rec) {
      const avgPrice = rec.priceCount > 0 ? rec.priceSum / rec.priceCount : 0;
      const avgMargin = rec.marginCount > 0 ? rec.marginSum / rec.marginCount : 0;
      series.push({
        month: ym,
        units: Math.round(rec.totalSales),
        price: Math.round(avgPrice * 100) / 100,
        margin: Math.round(avgMargin * 10000) / 10000,
      });
      if (prevPrice !== null && Math.abs(avgPrice - prevPrice) > 0.01) hasVariation = true;
      prevPrice = avgPrice;
    }
  }

  // Only include SKUs with at least 3 months of data and some price or demand variation
  if (series.length >= 3) {
    const totalUnits = series.reduce((s, d) => s + d.units, 0);
    const prices = series.map(d => d.price).filter(p => p > 0);
    const units = series.map(d => d.units);

    // Check for demand variation too
    const minUnits = Math.min(...units);
    const maxUnits = Math.max(...units);
    const demandVariation = maxUnits > 0 ? (maxUnits - minUnits) / maxUnits : 0;

    products.push({
      ...skuMeta[sku],
      totalUnits,
      avgPrice: prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100 : 0,
      series,
    });
  }
}

// Sort by total units descending
products.sort((a, b) => b.totalUnits - a.totalUnits);

console.log(`Output: ${products.length} products with sufficient data`);

const output = {
  generated: new Date().toISOString(),
  months: allMonths,
  products,
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(output));
console.log(`Written to ${OUT_PATH} (${(fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(1)} MB)`);
console.timeEnd("preprocess");
