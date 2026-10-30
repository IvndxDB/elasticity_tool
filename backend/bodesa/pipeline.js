/**
 * Pipeline Bodesa: S3 → calculo.js → caché en backend/data/bodesa/ (como pipeline_bara.py de Cascaron).
 *
 *   s3://data-bunker-prod-env/derivables/bodesa/
 *     client/Client.csv
 *     sell_in_sell_out/Sales_Data_Layout_Bodesa*.csv   (el más reciente; el Lay_Out_…_enero-febrero de 2 meses no se usa)
 *     competitors/bodesa_YYYY-MM-DD.csv                 (los últimos COMP_SNAPSHOTS cortes)
 *
 * Uso manual (desde backend/):  npm run bodesa
 */
const fs = require("fs");
const path = require("path");
const s3 = require("../s3");
const { calcularBodesa, COMP_SNAPSHOTS } = require("./calculo");

const PREFIJO = "derivables/bodesa/";
const CARPETAS = ["client/", "sell_in_sell_out/", "competitors/"]; // lo que alimenta el cálculo (logs/ no cuenta)
const OUT_DIR = path.join(__dirname, "..", "data", "bodesa");
const ARCHIVOS = { data: path.join(OUT_DIR, "data.json"), competitor: path.join(OUT_DIR, "competitor.json"), meta: path.join(OUT_DIR, "meta.json") };

const RE_VENTAS = /\/Sales_Data_Layout_Bodesa[^/]*\.csv$/i;
const RE_COMP = /\/bodesa_(\d{4}-\d{2}-\d{2})\.csv$/;

async function listarFuentes() {
  const objetos = (await Promise.all(CARPETAS.map((c) => s3.listar(PREFIJO + c)))).flat();
  const cliente = objetos.find((o) => o.key === `${PREFIJO}client/Client.csv`);
  const ventas = objetos.filter((o) => RE_VENTAS.test(o.key)).sort((a, b) => b.lastModified - a.lastModified)[0];
  const competencia = objetos.filter((o) => RE_COMP.test(o.key))
    .sort((a, b) => a.key.match(RE_COMP)[1].localeCompare(b.key.match(RE_COMP)[1]))
    .slice(-COMP_SNAPSHOTS);
  if (!cliente) throw new Error(`No está ${PREFIJO}client/Client.csv en s3://${s3.BUCKET}`);
  if (!ventas) throw new Error(`No hay Sales_Data_Layout_Bodesa*.csv en s3://${s3.BUCKET}/${PREFIJO}sell_in_sell_out/`);
  if (!competencia.length) throw new Error(`No hay cortes bodesa_AAAA-MM-DD.csv en s3://${s3.BUCKET}/${PREFIJO}competitors/`);
  const ultima = Math.max(...objetos.map((o) => o.lastModified));
  return { cliente, ventas, competencia, ultima };
}

/** Última modificación en S3 de lo que alimenta el cálculo (ms); el vigilante la compara con meta.fuente_s3 */
async function ultimaActualizacionS3() {
  return (await listarFuentes()).ultima;
}

function leerMeta() {
  try { return JSON.parse(fs.readFileSync(ARCHIVOS.meta, "utf8")); } catch { return null; }
}

// Escritura atómica: el servidor nunca sirve un JSON a medio escribir
function escribir(file, contenido) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, file);
}

async function ejecutar(log = console.log) {
  const t0 = Date.now();
  const f = await listarFuentes();
  const nombre = (o) => o.key.slice(o.key.lastIndexOf("/") + 1);
  log(`Bajando de s3://${s3.BUCKET}/${PREFIJO}: ${nombre(f.cliente)}, ${nombre(f.ventas)}, ${f.competencia.map(nombre).join(", ")}`);
  const [cliente, ventas, ...competencia] = await Promise.all([f.cliente, f.ventas, ...f.competencia].map((o) => s3.leerTexto(o.key)));
  const { data, competitor } = calcularBodesa({
    cliente,
    ventas,
    competencia: f.competencia.map((o, i) => ({ nombre: nombre(o), texto: competencia[i] })),
  }, log);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  escribir(ARCHIVOS.data, JSON.stringify(data));
  escribir(ARCHIVOS.competitor, JSON.stringify(competitor));
  const meta = {
    generado: new Date().toISOString(),
    fuente_s3: f.ultima,
    archivos: [f.cliente, f.ventas, ...f.competencia].map((o) => ({ key: o.key, lastModified: new Date(o.lastModified).toISOString() })),
    productos: data.products.length,
    con_competencia: Object.keys(competitor).length,
    segundos: Math.round((Date.now() - t0) / 1000),
  };
  escribir(ARCHIVOS.meta, JSON.stringify(meta, null, 2));
  log(`OK Bodesa: ${meta.productos} productos, ${meta.con_competencia} con competencia · ${meta.segundos}s`);
  return meta;
}

module.exports = { ARCHIVOS, ejecutar, leerMeta, ultimaActualizacionS3 };

if (require.main === module) {
  ejecutar().catch((e) => { console.error(e); process.exit(1); });
}
