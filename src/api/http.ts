import { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { App, appDeLlave, appPuedeCon } from "../almacen/apps";

/*
 * Un enrutador mínimo sobre el http de Node.
 *
 * Sin framework a propósito: este servicio guarda la firma electrónica de varios
 * contribuyentes, y cada dependencia que se agrega es código de terceros corriendo
 * junto a esas llaves. Lo que hace falta acá —rutas, JSON, autenticación— son unas
 * ochenta líneas.
 */

export class ErrorHttp extends Error {
  constructor(public codigo: number, mensaje: string) { super(mensaje); this.name = "ErrorHttp"; }
}
export const malaPeticion = (m: string) => new ErrorHttp(400, m);
export const noAutorizado = (m = "Llave de API inválida o inactiva.") => new ErrorHttp(401, m);
export const prohibido = (m: string) => new ErrorHttp(403, m);
export const noEncontrado = (m = "No existe.") => new ErrorHttp(404, m);

export interface Contexto {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  consulta: URLSearchParams;
  cuerpo: any;
  /** La aplicación que llama. Falta en las rutas públicas y en las de administración. */
  app?: App;
}

type Manejador = (c: Contexto) => Promise<unknown>;
type Guardia = "publica" | "app" | "admin";

interface Ruta { metodo: string; partes: string[]; guardia: Guardia; manejador: Manejador }

const rutas: Ruta[] = [];

export function ruta(metodo: string, patron: string, guardia: Guardia, manejador: Manejador): void {
  rutas.push({ metodo, partes: patron.split("/").filter(Boolean), guardia, manejador });
}

function calzar(metodo: string, camino: string): { r: Ruta; params: Record<string, string> } | null {
  const partes = camino.split("/").filter(Boolean);
  for (const r of rutas) {
    if (r.metodo !== metodo || r.partes.length !== partes.length) continue;
    const params: Record<string, string> = {};
    let calza = true;
    for (let i = 0; i < r.partes.length; i++) {
      const p = r.partes[i];
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(partes[i]);
      else if (p !== partes[i]) { calza = false; break; }
    }
    if (calza) return { r, params };
  }
  return null;
}

const MAX_CUERPO = 4 * 1024 * 1024; // un .pfx o un CAF no pasan de unos pocos KB

async function leerCuerpo(req: IncomingMessage): Promise<any> {
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const t of req) {
    total += t.length;
    if (total > MAX_CUERPO) throw malaPeticion("El cuerpo de la petición es demasiado grande.");
    trozos.push(t as Buffer);
  }
  if (!trozos.length) return {};
  const texto = Buffer.concat(trozos).toString("utf8");
  try { return JSON.parse(texto); } catch { throw malaPeticion("El cuerpo no es JSON válido."); }
}

/** Compara la llave de administración sin filtrar cuánto coincide. */
function esAdmin(llave: string): boolean {
  const esperada = process.env.DTE_LLAVE_ADMIN || "";
  if (esperada.length < 24) return false; // sin llave configurada, no hay administración
  const a = createHash("sha256").update(llave).digest();
  const b = createHash("sha256").update(esperada).digest();
  return timingSafeEqual(a, b);
}

const llaveDe = (req: IncomingMessage): string => {
  const h = String(req.headers.authorization || "");
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
};

export async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://local");
  const inicio = Date.now();

  try {
    const encontrada = calzar(req.method || "GET", url.pathname);
    if (!encontrada) throw noEncontrado(`No existe ${req.method} ${url.pathname}.`);
    const { r, params } = encontrada;

    const c: Contexto = { req, res, params, consulta: url.searchParams, cuerpo: {} };

    if (r.guardia === "admin" && !esAdmin(llaveDe(req))) {
      throw noAutorizado("Esta operación requiere la llave de administración.");
    }
    if (r.guardia === "app") {
      const app = await appDeLlave(llaveDe(req));
      if (!app) throw noAutorizado();
      c.app = app;
      // Una aplicación limitada no opera con emisores que no son suyos.
      if (params.rut && !appPuedeCon(app, params.rut)) {
        throw prohibido(`La aplicación ${app.nombre} no tiene permitido operar con ese emisor.`);
      }
    }

    if (req.method !== "GET" && req.method !== "DELETE") c.cuerpo = await leerCuerpo(req);

    const salida = await r.manejador(c);
    if (res.writableEnded) return; // el manejador ya respondió por su cuenta
    responder(res, 200, salida ?? { ok: true });
  } catch (e: any) {
    const codigo = e instanceof ErrorHttp ? e.codigo : 500;
    if (codigo >= 500) console.error(`[${req.method} ${url.pathname}]`, e);
    responder(res, codigo, { error: e?.message || "Error interno." });
  } finally {
    if (process.env.DTE_REGISTRO !== "silencio") {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - inicio}ms`);
    }
  }
}

export function responder(res: ServerResponse, codigo: number, cuerpo: unknown): void {
  const texto = JSON.stringify(cuerpo);
  res.writeHead(codigo, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(texto),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(texto);
}

/** Lee un archivo que vino en base64 dentro del JSON. */
export function archivoDe(v: unknown, queEs: string): Buffer {
  const s = String(v || "").replace(/^data:[^,]+,/, "");
  if (!s) throw malaPeticion(`Falta ${queEs}.`);
  const b = Buffer.from(s, "base64");
  if (!b.length) throw malaPeticion(`No se pudo leer ${queEs}: ¿viene en base64?`);
  return b;
}
