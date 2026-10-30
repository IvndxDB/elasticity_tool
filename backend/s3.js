/**
 * Cliente ligero de S3 (mismo patrón que athena.py del proyecto Cascaron).
 * Credenciales: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY de backend/.env; si no están, la cadena estándar de AWS
 * (perfil de ~/.aws/credentials, SSO, rol de la máquina…).
 */
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");

const AWS_REGION = process.env.AWS_REGION || "us-east-2";
const BUCKET = process.env.S3_BUCKET || "data-bunker-prod-env";

let cliente = null;
const s3 = () => cliente || (cliente = new S3Client({ region: AWS_REGION }));

/** Objetos bajo un prefijo: [{ key, size, lastModified (ms) }], sin las "carpetas" vacías */
async function listar(prefijo) {
  const out = [];
  let ContinuationToken;
  do {
    const r = await s3().send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefijo, ContinuationToken }));
    for (const o of r.Contents || []) {
      if (!o.Key.endsWith("/")) out.push({ key: o.Key, size: o.Size, lastModified: o.LastModified.getTime() });
    }
    ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}

async function leerTexto(key) {
  const r = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return r.Body.transformToString("utf-8");
}

module.exports = { AWS_REGION, BUCKET, listar, leerTexto };
