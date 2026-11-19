import { createSign, createVerify, createPublicKey } from "node:crypto";
import { Caf, rutPlano } from "./caf";

/*
 * El TED (Timbre Electrónico) es lo que convierte un folio en un documento válido:
 * dentro va el bloque <CAF> del SII y, firmando todo eso, la clave privada del CAF.
 *
 * Regla de oro: **se firman exactamente los bytes que se envían**. El SII verifica
 * la firma sobre el <DD> tal como aparece en el XML, sin canonicalizar. Por eso acá
 * el <DD> se arma una sola vez como texto, se firma ese texto, y ese mismo texto es
 * el que se incrusta. Cualquier paso por un DOM intermedio rompería la firma.
 */

export interface DatosTimbre {
  tipo: number;
  folio: number;
  /** Fecha de emisión, YYYY-MM-DD. */
  fecha: string;
  rutEmisor: string;
  rutReceptor: string;
  razonReceptor: string;
  /** Monto total del documento, entero en pesos. */
  monto: number;
  /** Nombre del primer ítem del detalle. */
  primerItem: string;
}

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** El SII corta estos campos a 40 caracteres; mejor cortarlos acá que ser rechazado. */
const corta = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Fecha y hora de Chile en el formato del SII: 2026-11-19T16:50:00 */
export function instanteSii(d: Date = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
}

/** El <DD> literal, que es lo que se firma y lo que se envía. */
export function bloqueDD(caf: Caf, d: DatosTimbre, ahora: Date = new Date()): string {
  return "<DD>"
    + `<RE>${esc(rutPlano(d.rutEmisor))}</RE>`
    + `<TD>${d.tipo}</TD>`
    + `<F>${d.folio}</F>`
    + `<FE>${d.fecha}</FE>`
    + `<RR>${esc(rutPlano(d.rutReceptor))}</RR>`
    + `<RSR>${esc(corta(d.razonReceptor, 40))}</RSR>`
    + `<MNT>${Math.round(d.monto)}</MNT>`
    + `<IT1>${esc(corta(d.primerItem, 40))}</IT1>`
    + caf.xml
    + `<TSTED>${instanteSii(ahora)}</TSTED>`
    + "</DD>";
}

/**
 * Arma el <TED> completo: el <DD> y su firma con la clave del CAF.
 *
 * Devuelve también el <DD> por separado, porque quien arme el documento tiene que
 * incrustar **este mismo texto** y no una versión equivalente.
 */
export function timbre(caf: Caf, d: DatosTimbre, ahora: Date = new Date()): { ted: string; dd: string } {
  if (d.tipo !== caf.tipo) throw new Error(`Este CAF es para documentos tipo ${caf.tipo}, no ${d.tipo}.`);
  if (d.folio < caf.desde || d.folio > caf.hasta) throw new Error(`El folio ${d.folio} está fuera del rango autorizado (${caf.desde}–${caf.hasta}).`);
  if (rutPlano(d.rutEmisor) !== caf.rutEmisor) throw new Error("El CAF es de otro RUT emisor.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.fecha)) throw new Error("La fecha de emisión debe ser YYYY-MM-DD.");

  const dd = bloqueDD(caf, d, ahora);
  const firma = createSign("RSA-SHA1").update(dd, "utf8").sign(caf.privada, "base64");
  return { ted: `<TED version="1.0">${dd}<FRMT algoritmo="SHA1withRSA">${firma}</FRMT></TED>`, dd };
}

/**
 * Verifica un timbre con la clave pública del propio CAF. No lo usa la emisión: sirve
 * para las pruebas y para revisar un documento antes de mandarlo.
 */
export function timbreValido(caf: Caf, ted: string): boolean {
  const dd = ted.match(/<DD>[\s\S]*<\/DD>/)?.[0];
  const frmt = ted.match(/<FRMT[^>]*>([\s\S]*?)<\/FRMT>/)?.[1]?.trim();
  if (!dd || !frmt) return false;
  const publica = createPublicKey(caf.privada);
  return createVerify("RSA-SHA1").update(dd, "utf8").verify(publica, frmt, "base64");
}
