import { createPrivateKey, KeyObject } from "node:crypto";

/*
 * El CAF (Código de Autorización de Folios) es el archivo que entrega el SII con un
 * rango de folios para un tipo de documento. Trae tres cosas que importan: el rango,
 * la clave privada RSA con la que se timbra cada documento, y la firma del propio SII
 * sobre la autorización.
 *
 * El bloque <CAF>…</CAF> viaja **entero y literal** dentro del timbre de cada
 * documento. Por eso acá se guarda el texto tal cual viene: volver a serializarlo
 * desde un DOM cambiaría algún byte —un espacio, el orden de un atributo— y la firma
 * del SII dejaría de validar.
 */

export interface Caf {
  /** Tipo de documento: 33 factura, 34 exenta, 39 boleta, 61 nota de crédito… */
  tipo: number;
  rutEmisor: string;
  razon: string;
  desde: number;
  hasta: number;
  /** Fecha de autorización, YYYY-MM-DD. */
  fecha: string;
  /** El <CAF>…</CAF> literal, para incrustarlo en el <DD> del timbre. */
  xml: string;
  /** Clave RSA con la que se firma el timbre de cada documento. */
  privada: KeyObject;
}

/** Lee un valor simple. Sirve porque el formato del SII es plano y conocido. */
function campo(xml: string, etiqueta: string): string {
  const m = xml.match(new RegExp(`<${etiqueta}>([\\s\\S]*?)</${etiqueta}>`));
  return m ? m[1].trim() : "";
}

/** Normaliza un RUT a 12345678-9: sin puntos, sin espacios, con K mayúscula. */
export function rutPlano(r: string): string {
  return r.replace(/[^0-9kK]/g, "").replace(/k/g, "K").replace(/^(\d+)([\dK])$/, "$1-$2");
}

/**
 * Lee el XML de un CAF descargado del SII.
 *
 * Lanza si el archivo no es un CAF o le falta algo esencial: es preferible fallar al
 * cargarlo que descubrirlo cuando el SII rechace un documento ya emitido.
 */
export function leerCaf(xml: string): Caf {
  const bloque = xml.match(/<CAF[\s>][\s\S]*?<\/CAF>/);
  if (!bloque) throw new Error("El archivo no parece un CAF: no tiene el bloque <CAF>.");

  const da = xml.match(/<DA>[\s\S]*?<\/DA>/)?.[0] || "";
  const rng = da.match(/<RNG>[\s\S]*?<\/RNG>/)?.[0] || "";
  const tipo = Number(campo(da, "TD"));
  const desde = Number(campo(rng, "D"));
  const hasta = Number(campo(rng, "H"));
  const rutEmisor = rutPlano(campo(da, "RE"));
  const pem = campo(xml, "RSASK");

  if (!tipo) throw new Error("El CAF no dice para qué tipo de documento es.");
  if (!desde || !hasta || hasta < desde) throw new Error("El CAF no trae un rango de folios válido.");
  if (!rutEmisor) throw new Error("El CAF no trae el RUT del emisor.");
  if (!pem.includes("PRIVATE KEY")) throw new Error("El CAF no trae la clave privada para timbrar.");

  let privada: KeyObject;
  try { privada = createPrivateKey(pem); }
  catch { throw new Error("La clave privada del CAF no se pudo leer."); }

  return { tipo, rutEmisor, razon: campo(da, "RS"), desde, hasta, fecha: campo(da, "FA"), xml: bloque[0], privada };
}

/** ¿Este folio cae dentro del rango autorizado? */
export const folioEnRango = (c: Caf, folio: number): boolean => folio >= c.desde && folio <= c.hasta;

/** Cuántos folios quedan sin usar desde `usado` (el último entregado). */
export const foliosRestantes = (c: Caf, usado: number): number => Math.max(0, c.hasta - Math.max(usado, c.desde - 1));
