/**
 * Pre-process fesa_2026-04-17.csv → public/competitor.json
 * Groups competitor prices and images by UPC (one record per UPC with list of competitors).
 */
const fs = require("fs");
const path = require("path");

const CSV_PATH = path.join(__dirname, "fesa_2026-04-17.csv");
const OUT_PATH = path.join(__dirname, "app", "public", "competitor.json");

console.time("preprocess-competitor");

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

const raw = fs.readFileSync(CSV_PATH, "utf-8");
const lines = raw.split(/\r?\n/);
const header = parseCsvLine(lines[0].replace(/^\uFEFF/, ""));
const col = {};
header.forEach((h, i) => (col[h.trim()] = i));

console.log("Headers detected:", Object.keys(col).length);

function get(parts, name) {
  const idx = col[name];
  return idx !== undefined ? (parts[idx] || "").trim() : "";
}

// normalize UPC: trim, remove leading zeros (so matches between sales and competitor work)
function normUpc(u) {
  if (!u) return "";
  return String(u).replace(/\D/g, "").replace(/^0+/, "");
}

// byUpc: upc -> { image, competitors: [{canal, price, url, brand}] }
const byUpc = {};

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line || line.trim() === "") continue;
  let parts;
  try { parts = parseCsvLine(line); } catch (e) { continue; }

  const upcRaw = get(parts, "upc");
  const upc = normUpc(upcRaw);
  if (!upc) continue;

  const canal = get(parts, "canal");
  const priceStr = get(parts, "final price") || get(parts, "price");
  const price = parseFloat(priceStr);
  const image = get(parts, "image");
  const urlSku = get(parts, "url sku");
  const brand = get(parts, "marca");
  const item = get(parts, "item");

  if (!byUpc[upc]) byUpc[upc] = { upc, image: "", item: "", brand: "", competitors: [] };

  // first valid image wins
  if (image && !byUpc[upc].image && /^https?:\/\//.test(image)) byUpc[upc].image = image;
  if (item && !byUpc[upc].item) byUpc[upc].item = item;
  if (brand && !byUpc[upc].brand) byUpc[upc].brand = brand;

  if (isFinite(price) && price > 0 && canal) {
    byUpc[upc].competitors.push({ canal, price: Math.round(price * 100) / 100, url: urlSku, brand });
  }
}

// Reduce each UPC: min / avg / max competitor price + list (dedup by canal keeping lowest price)
const out = {};
for (const upc of Object.keys(byUpc)) {
  const rec = byUpc[upc];
  // dedup by canal
  const byCanal = {};
  for (const c of rec.competitors) {
    if (!byCanal[c.canal] || c.price < byCanal[c.canal].price) byCanal[c.canal] = c;
  }
  const comps = Object.values(byCanal).sort((a, b) => a.price - b.price);
  const prices = comps.map(c => c.price);
  out[upc] = {
    upc,
    image: rec.image || null,
    item: rec.item || null,
    brand: rec.brand || null,
    competitors: comps,
    minPrice: prices.length ? prices[0] : null,
    avgPrice: prices.length ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100 : null,
    maxPrice: prices.length ? prices[prices.length - 1] : null,
  };
}

console.log(`Output: ${Object.keys(out).length} UPCs with competitor data`);

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`Written to ${OUT_PATH} (${(fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(2)} MB)`);
console.timeEnd("preprocess-competitor");
