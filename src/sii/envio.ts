import { Certificado } from "./cert";
import { firmarXml } from "./firma";
import { instanteSii, esc } from "./ted";
import { rutPlano } from "./caf";

/*
 * El sobre. Los documentos ya firmados se empaquetan en un <EnvioDTE> con una
 * carátula que dice quién emite, quién envía, para quién va y con qué resolución
 * del SII. El sobre se firma a su vez: queda una firma por documento y una del sobre.
 *
 * El número y la fecha de resolución son **del emisor**, no de Patiolo: salen de la
 * resolución con que el SII lo habilitó a facturar electrónicamente.
 */

export interface Resolucion {
  /** Fecha de la resolución, YYYY-MM-DD. En certificación va la del ambiente de prueba. */
  fecha: string;
  /** Número de la resolución. En certificación es 0. */
  numero: number;
}

export interface DatosSobre {
  rutEmisor: string;
  /** RUT de quien envía: el titular del certificado con el que se firma. */
  rutEnvia: string;
  /** RUT del receptor. Para boletas y envíos al SII va 60803000-K. */
  rutReceptor: string;
  resolucion: Resolucion;
}

/** El SII es el receptor cuando el envío no va dirigido a un contribuyente. */
export const RUT_SII = "60803000-K";

/** Cuenta cuántos documentos de cada tipo lleva el sobre, para la carátula. */
function subtotales(dtes: string[]): string {
  const cuenta = new Map<string, number>();
  for (const d of dtes) {
    const tipo = d.match(/<TipoDTE>(\d+)<\/TipoDTE>/)?.[1];
    if (!tipo) throw new Error("Un documento del sobre no declara su tipo.");
    cuenta.set(tipo, (cuenta.get(tipo) || 0) + 1);
  }
  return [...cuenta.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([tipo, n]) => `<SubTotDTE><TpoDTE>${tipo}</TpoDTE><NroDTE>${n}</NroDTE></SubTotDTE>`)
    .join("");
}

/**
 * Arma el <EnvioDTE> y lo firma.
 *
 * Los documentos entran ya firmados: la firma de cada uno queda intacta porque la
 * canonicalización exclusiva hace que el espacio de nombres heredado del sobre no
 * cambie lo que se firmó.
 */
export function armarSobre(dtes: string[], d: DatosSobre, cert: Certificado, ahora: Date = new Date()): string {
  if (!dtes.length) throw new Error("El sobre no lleva ningún documento.");
  if (dtes.length > 2000) throw new Error("Un sobre admite hasta 2.000 documentos.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.resolucion.fecha)) throw new Error("La fecha de la resolución debe ser YYYY-MM-DD.");

  const caratula = '<Caratula version="1.0">'
    + `<RutEmisor>${esc(rutPlano(d.rutEmisor))}</RutEmisor>`
    + `<RutEnvia>${esc(rutPlano(d.rutEnvia))}</RutEnvia>`
    + `<RutReceptor>${esc(rutPlano(d.rutReceptor))}</RutReceptor>`
    + `<FchResol>${d.resolucion.fecha}</FchResol>`
    + `<NroResol>${Math.max(0, Math.round(d.resolucion.numero))}</NroResol>`
    + `<TmstFirmaEnv>${instanteSii(ahora)}</TmstFirmaEnv>`
    + subtotales(dtes)
    + "</Caratula>";

  const xml = '<EnvioDTE xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
    + ' xsi:schemaLocation="http://www.sii.cl/SiiDte EnvioDTE_v10.xsd" version="1.0">'
    + '<SetDTE ID="SetDoc">'
    + caratula
    + dtes.join("")
    + "</SetDTE>"
    + "</EnvioDTE>";

  return '<?xml version="1.0" encoding="ISO-8859-1"?>' + firmarXml(xml, "SetDoc", "EnvioDTE", cert);
}

/**
 * El SII trabaja en ISO-8859-1. Se convierte al final, ya firmado.
 *
 * No afecta a las firmas: la canonicalización trabaja sobre caracteres, no sobre
 * bytes, así que el receptor vuelve a obtener el mismo texto al leer el XML. Las
 * tildes y la ñ existen en Latin-1 y se conservan; lo que no cabe —comillas
 * tipográficas, guiones largos, emoji— se cambia por un equivalente de toda la vida
 * antes de convertir, porque si no se convertiría en un byte cualquiera.
 */
export function aLatin1(xml: string): Buffer {
  const equivalentes: Record<string, string> = {
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", "…": "...", " ": " ", "€": "EUR",
  };
  const cabe = (c: string) => c.codePointAt(0)! <= 0xff;
  const plano = [...xml].map((c) => {
    if (cabe(c)) return c;
    if (equivalentes[c]) return equivalentes[c];
    // Última opción: quitarle la tilde a una letra que no esté en Latin-1.
    const sin = c.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return [...sin].every(cabe) && sin ? sin : "?";
  }).join("");
  return Buffer.from(plano, "latin1");
}
