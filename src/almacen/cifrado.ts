import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from "node:crypto";

/*
 * Cifrado en reposo del material sensible: el .pfx de cada emisor, su clave y el
 * XML de cada CAF.
 *
 * El certificado es la firma electrónica del representante legal de un contribuyente
 * y el CAF trae la clave con la que se timbran sus folios. Un respaldo de la base de
 * datos que se filtre no puede alcanzar para emitir en nombre de nadie, así que todo
 * eso se guarda cifrado y la llave maestra vive en una variable de entorno, fuera de
 * la base y fuera del repositorio.
 *
 * AES-256-GCM: además de cifrar, autentica. Si alguien altera un byte del guardado,
 * el descifrado falla en vez de devolver basura.
 */

const ALGORITMO = "aes-256-gcm";
const LARGO_IV = 12;   // lo que recomienda GCM
const LARGO_TAG = 16;

let llave: Buffer | null = null;

/**
 * La llave maestra, derivada de DTE_LLAVE_MAESTRA.
 *
 * Se espera una cadena larga y aleatoria (al menos 32 caracteres). Se deriva con
 * SHA-256 para tener siempre 32 bytes, sin obligar a que la variable sea binaria.
 */
export function llaveMaestra(): Buffer {
  if (llave) return llave;
  const bruta = process.env.DTE_LLAVE_MAESTRA || "";
  if (bruta.length < 32) {
    throw new Error(
      "Falta DTE_LLAVE_MAESTRA o es demasiado corta (mínimo 32 caracteres). " +
      "Sin ella no se pueden leer los certificados guardados. Genera una con: openssl rand -base64 48",
    );
  }
  llave = createHash("sha256").update(bruta, "utf8").digest();
  return llave;
}

/** Para las pruebas y para cuando la variable cambia en caliente. */
export const olvidarLlave = (): void => { llave = null; };

/**
 * Cifra. El resultado es un solo buffer: IV + tag + contenido, para guardarlo en
 * una columna y no en tres.
 */
export function cifrar(datos: Buffer): Buffer {
  const iv = randomBytes(LARGO_IV);
  const c = createCipheriv(ALGORITMO, llaveMaestra(), iv);
  const cuerpo = Buffer.concat([c.update(datos), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), cuerpo]);
}

/** Descifra lo que devolvió `cifrar`. Lanza si el contenido fue alterado. */
export function descifrar(guardado: Buffer): Buffer {
  if (guardado.length < LARGO_IV + LARGO_TAG + 1) throw new Error("El dato cifrado está incompleto.");
  const iv = guardado.subarray(0, LARGO_IV);
  const tag = guardado.subarray(LARGO_IV, LARGO_IV + LARGO_TAG);
  const cuerpo = guardado.subarray(LARGO_IV + LARGO_TAG);
  const d = createDecipheriv(ALGORITMO, llaveMaestra(), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(cuerpo), d.final()]);
  } catch {
    throw new Error("No se pudo descifrar: la llave maestra no corresponde o el dato fue alterado.");
  }
}

export const cifrarTexto = (s: string): Buffer => cifrar(Buffer.from(s, "utf8"));
export const descifrarTexto = (b: Buffer): string => descifrar(b).toString("utf8");

/*
 * Llaves de API de las aplicaciones cliente.
 *
 * Se guarda el hash, nunca la llave: si la base se filtra, no se puede entrar con
 * lo que hay dentro. La comparación es de tiempo constante para no filtrar el
 * prefijo correcto a fuerza de medir cuánto tarda.
 */

export const nuevaLlaveApi = (): string => "dte_" + randomBytes(32).toString("base64url");

export const hashLlaveApi = (llaveApi: string): string =>
  createHash("sha256").update(llaveApi, "utf8").digest("hex");

export function llaveApiCalza(llaveApi: string, hashGuardado: string): boolean {
  const a = Buffer.from(hashLlaveApi(llaveApi), "hex");
  const b = Buffer.from(hashGuardado, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
