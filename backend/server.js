/**
 * API del Price Elasticity Engine (mismo patrón que backend/main.py del proyecto Cascaron, en Node sin framework).
 *
 *   GET  /api/health                 estado + bucket/región
 *   GET  /api/bodesa/data.json       dataset de la app (503 mientras se genera la primera vez)
 *   GET  /api/bodesa/competitor.json precios de competencia por UPC
 *   GET  /api/bodesa/version         cuándo se generó, con qué archivos de S3 y si está actualizando
 *   POST /api/bodesa/refresh         fuerza bajar de S3 y recalcular en segundo plano
 *
 * Al arrancar genera el caché si no existe; luego cada CHECK_MIN minutos revisa si S3 tiene algo más nuevo que lo
 * usado en el último cálculo y recalcula. Si un cálculo falla se sigue sirviendo el último dataset válido.
 *
 *   npm start   (o run.bat)   →   http://127.0.0.1:8011
 */
const fs = require("fs");
const http = require("http");
const zlib = require("zlib");
const s3 = require("./s3");
const bodesa = require("./bodesa/pipeline");

const PORT = Number(process.env.BACKEND_PORT || 8011);
const CHECK_MIN = Number(process.env.CHECK_MIN || 30);

const estado = { running: false, error: null, revisado: null };
const cache = {}; // file -> { mtime, raw, gz }

async function refrescar() {
  if (estado.running) return;
  estado.running = true;
  try {
    await bodesa.ejecutar((m) => console.log(`[bodesa] ${m}`));
    estado.error = null;
  } catch (e) { // se sirve el último dataset válido
    estado.error = String(e.message || e);
    console.error("[bodesa] error:", e);
  } finally {
    estado.running = false;
  }
}

async function vigilar() {
  const meta = bodesa.leerMeta();
  if (!meta || !fs.existsSync(bodesa.ARCHIVOS.data)) await refrescar();
  for (;;) {
    await new Promise((r) => setTimeout(r, CHECK_MIN * 60 * 1000));
    try {
      const ultimo = await bodesa.ultimaActualizacionS3();
      estado.revisado = new Date().toISOString();
      if (ultimo > (bodesa.leerMeta()?.fuente_s3 || 0)) await refrescar();
    } catch (e) {
      estado.error = String(e.message || e);
    }
  }
}

// Archivo del caché en memoria, ya comprimido; se recarga solo cuando el pipeline lo reescribe
function cargar(file) {
  const mtime = fs.statSync(file).mtimeMs;
  if (cache[file]?.mtime !== mtime) {
    const raw = fs.readFileSync(file);
    cache[file] = { mtime, raw, gz: zlib.gzipSync(raw) };
  }
  return cache[file];
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

function servirArchivo(req, res, file, que) {
  if (!fs.existsSync(file)) {
    return json(res, 503, { detail: estado.error || `Generando ${que} de Bodesa desde S3 (≈1 min). Reintenta en un momento.`, actualizando: estado.running });
  }
  const { raw, gz } = cargar(file);
  const usaGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    ...(usaGzip ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}),
  });
  res.end(usaGzip ? gz : raw);
}

const rutas = {
  "GET /api/health": (req, res) => json(res, 200, { status: "ok", bucket: s3.BUCKET, region: s3.AWS_REGION }),
  "GET /api/bodesa/data.json": (req, res) => servirArchivo(req, res, bodesa.ARCHIVOS.data, "el dataset"),
  "GET /api/bodesa/competitor.json": (req, res) => servirArchivo(req, res, bodesa.ARCHIVOS.competitor, "los precios de competencia"),
  "GET /api/bodesa/version": (req, res) => json(res, 200, {
    ...(bodesa.leerMeta() || {}), actualizando: estado.running, ultima_revision_s3: estado.revisado, error: estado.error,
  }),
  "POST /api/bodesa/refresh": (req, res) => { refrescar(); json(res, 202, { status: "actualizando" }); },
};

http.createServer((req, res) => {
  const ruta = rutas[`${req.method} ${req.url.split("?")[0]}`];
  if (!ruta) return json(res, 404, { detail: "No encontrado" });
  try { ruta(req, res); } catch (e) { json(res, 500, { detail: String(e.message || e) }); }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`API en http://127.0.0.1:${PORT} · s3://${s3.BUCKET} (${s3.AWS_REGION}) · revisa S3 cada ${CHECK_MIN} min`);
  vigilar();
});
