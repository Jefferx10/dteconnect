import { Certificado } from "./cert";
import { firmarSemilla } from "./firma";
import { rutPlano } from "./caf";

/*
 * La conversación con el SII.
 *
 * Son cuatro pasos: pedir una semilla, firmarla con el certificado para cambiarla
 * por un token, subir el sobre, y después preguntar por el TRACKID hasta que el SII
 * conteste. El token dura un rato y se guarda mientras sirva: pedir uno por cada
 * documento es lento y el SII lo nota.
 *
 * Dos ambientes, el mismo código: `maullin` para certificación y `palena` para
 * producción. Lo único que cambia es la base de la URL y los folios que se usan.
 */

export type Ambiente = "certificacion" | "produccion";

const BASE: Record<Ambiente, string> = {
  certificacion: "https://maullin.sii.cl",
  produccion: "https://palena.sii.cl",
};

/* El SII rechaza las peticiones sin User-Agent. No está documentado; se descubre
   recibiendo un error que no dice nada. */
const AGENTE = "Mozilla/4.0 (compatible; PROG 1.0; Windows NT)";

const TOKEN_VIVE_MS = 50 * 60 * 1000; // el SII da una hora; se renueva antes

interface TokenGuardado { token: string; hasta: number }
const tokens = new Map<string, TokenGuardado>();

/** Saca el contenido de una etiqueta, venga o no con prefijo de espacio de nombres. */
function dentro(xml: string, etiqueta: string): string {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${etiqueta}>([\\s\\S]*?)</(?:\\w+:)?${etiqueta}>`, "i"));
  return m ? m[1].trim() : "";
}

/** El SII devuelve el XML de respuesta escapado dentro del sobre SOAP. */
const desescapar = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

async function pedir(url: string, opciones: RequestInit & { timeoutMs?: number } = {}): Promise<string> {
  const { timeoutMs = 30000, ...resto } = opciones;
  const corte = AbortSignal.timeout(timeoutMs);
  let r: Response;
  try {
    r = await fetch(url, { ...resto, signal: corte, headers: { "User-Agent": AGENTE, ...(resto.headers || {}) } });
  } catch (e: any) {
    throw new Error(e?.name === "TimeoutError"
      ? `El SII no respondió en ${timeoutMs / 1000} segundos (${url}).`
      : `No se pudo llegar al SII: ${String(e?.message || e)}`);
  }
  const texto = await r.text();
  if (!r.ok) throw new Error(`El SII respondió ${r.status} en ${url}: ${texto.slice(0, 300)}`);
  return texto;
}

/** Paso 1: la semilla. Dura unos minutos y sirve una sola vez. */
export async function semilla(amb: Ambiente): Promise<string> {
  const sobre = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">'
    + "<soapenv:Body><getSeed/></soapenv:Body></soapenv:Envelope>";

  const r = await pedir(`${BASE[amb]}/DTEWS/CrSeed.jws`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
    body: sobre,
  });

  const cuerpo = desescapar(dentro(r, "getSeedReturn") || r);
  const s = dentro(cuerpo, "SEMILLA");
  if (!s) {
    const estado = dentro(cuerpo, "GLOSA") || dentro(cuerpo, "ESTADO");
    throw new Error(`El SII no entregó una semilla${estado ? `: ${estado}` : "."}`);
  }
  return s;
}

/**
 * Paso 2: cambiar la semilla firmada por un token.
 *
 * El token queda guardado por emisor y ambiente, porque sirve para todos los envíos
 * de ese certificado durante la hora siguiente.
 */
export async function token(amb: Ambiente, cert: Certificado, forzar = false): Promise<string> {
  const clave = `${amb}:${cert.rut || cert.certB64.slice(0, 24)}`;
  const guardado = tokens.get(clave);
  if (!forzar && guardado && guardado.hasta > Date.now()) return guardado.token;

  const firmada = firmarSemilla(await semilla(amb), cert);
  const sobre = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">'
    + `<soapenv:Body><getToken><pszXml><![CDATA[${firmada}]]></pszXml></getToken></soapenv:Body>`
    + "</soapenv:Envelope>";

  const r = await pedir(`${BASE[amb]}/DTEWS/GetTokenFromSeed.jws`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
    body: sobre,
  });

  const cuerpo = desescapar(dentro(r, "getTokenFromSeedReturn") || r);
  const t = dentro(cuerpo, "TOKEN");
  if (!t) {
    const glosa = dentro(cuerpo, "GLOSA") || dentro(cuerpo, "ESTADO");
    throw new Error(`El SII no entregó un token${glosa ? `: ${glosa}` : ". Revisa que el certificado esté vigente y autorizado."}`);
  }
  tokens.set(clave, { token: t, hasta: Date.now() + TOKEN_VIVE_MS });
  return t;
}

/** Olvida el token guardado. Se usa al reemplazar un certificado. */
export const olvidarToken = (amb?: Ambiente): void => {
  if (!amb) { tokens.clear(); return; }
  for (const k of tokens.keys()) if (k.startsWith(amb + ":")) tokens.delete(k);
};

const partes = (rut: string): { cuerpo: string; dv: string } => {
  const [cuerpo, dv] = rutPlano(rut).split("-");
  return { cuerpo, dv };
};

export interface Envio {
  trackId: string;
  estado: string;
  glosa: string;
}

/**
 * Paso 3: subir el sobre.
 *
 * Devuelve un TRACKID, que no significa que el documento esté aceptado: significa
 * que el SII lo recibió. El resultado se pregunta después.
 */
export async function enviar(
  amb: Ambiente, cert: Certificado, sobre: Buffer,
  rutEmisor: string, rutEnvia: string,
): Promise<Envio> {
  const t = await token(amb, cert);
  const em = partes(rutEmisor), en = partes(rutEnvia);

  const forma = new FormData();
  forma.append("rutSender", en.cuerpo);
  forma.append("dvSender", en.dv);
  forma.append("rutCompany", em.cuerpo);
  forma.append("dvCompany", em.dv);
  // El SII espera el XML como archivo adjunto, en ISO-8859-1.
  forma.append("archivo", new Blob([new Uint8Array(sobre)], { type: "text/xml" }), "envio.xml");

  const r = await pedir(`${BASE[amb]}/cgi_dte/UPL/DTEUpload`, {
    method: "POST",
    headers: { Cookie: `TOKEN=${t}`, Referer: `${BASE[amb]}/cgi_dte/UPL/DTEUpload` },
    body: forma,
    timeoutMs: 60000,
  });

  const trackId = dentro(r, "TRACKID");
  const estado = dentro(r, "STATUS") || dentro(r, "ESTADO");
  const glosa = dentro(r, "DETAIL") || dentro(r, "GLOSA");
  if (!trackId) throw new Error(`El SII recibió el envío pero no entregó un TRACKID${glosa ? `: ${glosa}` : `. Respondió: ${r.slice(0, 300)}`}`);

  return { trackId, estado: estado || "0", glosa };
}

export interface EstadoEnvio {
  /** Lo que dice el SII, tal cual. */
  estado: string;
  glosa: string;
  /** Resuelto a algo accionable, para no repartir la interpretación por el código. */
  resultado: "procesando" | "aceptado" | "aceptado_con_reparos" | "rechazado";
  aceptados: number;
  reparos: number;
  rechazados: number;
}

/* Cómo se lee la respuesta del SII. Los códigos que importan:
   - EPR: envío procesado
   - SOK / RCT / RFR: recibido, correcto o rechazado
   - RCH, RSC, VOF, RCR: distintas formas de rechazo
   - RPR: procesado con reparos
   Mientras diga "-11", "SOK" o "RCT" todavía está en camino. */
function interpretar(estado: string, aceptados: number, reparos: number, rechazados: number): EstadoEnvio["resultado"] {
  const e = estado.toUpperCase();
  if (["RCH", "RSC", "VOF", "RCR", "RFR"].includes(e) || (rechazados > 0 && aceptados === 0)) return "rechazado";
  if (e === "RPR" || reparos > 0) return "aceptado_con_reparos";
  if (e === "EPR" && aceptados > 0) return "aceptado";
  return "procesando";
}

/** Paso 4: preguntar cómo le fue al envío. Puede tardar minutos. */
export async function estado(amb: Ambiente, cert: Certificado, rutEmisor: string, trackId: string): Promise<EstadoEnvio> {
  const t = await token(amb, cert);
  const em = partes(rutEmisor);

  const sobre = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">'
    + "<soapenv:Body><getEstUp>"
    + `<Rut>${em.cuerpo}</Rut><Dv>${em.dv}</Dv><TrackId>${trackId}</TrackId><Token>${t}</Token>`
    + "</getEstUp></soapenv:Body></soapenv:Envelope>";

  const r = await pedir(`${BASE[amb]}/DTEWS/QueryEstUp.jws`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
    body: sobre,
  });

  const cuerpo = desescapar(dentro(r, "getEstUpReturn") || r);
  const est = dentro(cuerpo, "ESTADO");
  const glosa = dentro(cuerpo, "GLOSA") || dentro(cuerpo, "GLOSA_ESTADO");
  const num = (t2: string) => Number(dentro(cuerpo, t2) || 0);
  const aceptados = num("ACEPTADOS"), reparos = num("REPAROS"), rechazados = num("RECHAZADOS");

  if (!est) throw new Error(`El SII no entregó el estado del envío ${trackId}. Respondió: ${cuerpo.slice(0, 300)}`);
  return { estado: est, glosa, resultado: interpretar(est, aceptados, reparos, rechazados), aceptados, reparos, rechazados };
}

/**
 * Pregunta por el envío hasta que el SII deje de decir "procesando".
 *
 * No es para usar dentro de una petición HTTP: el SII puede tardar minutos. Va en
 * un trabajo aparte que actualiza el documento cuando hay respuesta.
 */
export async function esperarEstado(
  amb: Ambiente, cert: Certificado, rutEmisor: string, trackId: string,
  { intentos = 20, cada = 15000 }: { intentos?: number; cada?: number } = {},
): Promise<EstadoEnvio> {
  let ultimo: EstadoEnvio = { estado: "", glosa: "", resultado: "procesando", aceptados: 0, reparos: 0, rechazados: 0 };
  for (let i = 0; i < intentos; i++) {
    ultimo = await estado(amb, cert, rutEmisor, trackId);
    if (ultimo.resultado !== "procesando") return ultimo;
    await new Promise((ok) => setTimeout(ok, cada));
  }
  return ultimo;
}
