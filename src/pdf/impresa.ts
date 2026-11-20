import PDFDocument from "pdfkit";
import { toBuffer } from "bwip-js";

/*
 * La representación impresa del documento.
 *
 * Es lo que se le entrega al receptor y lo que el SII pide en las "muestras de
 * impresión" de la certificación. Lo que no puede faltar:
 *
 *  - El recuadro rojo con el RUT del emisor, el tipo de documento y el folio.
 *  - El timbre electrónico como código de barras PDF417, que codifica el <TED>
 *    **literal** del documento: es lo que permite verificarlo sin conexión.
 *  - La leyenda de la resolución con la que el SII autorizó a ese emisor.
 *
 * El PDF417 se genera desde el TED tal cual viene en el XML. Cualquier reescritura
 * —un espacio, un salto de línea— lo invalida.
 */

export interface DatosImpresion {
  tipo: number;
  folio: number;
  fecha: string;
  emisor: { rut: string; razon: string; giro: string; direccion: string; comuna: string; ciudad?: string | null };
  receptor: { rut: string; razon: string; giro?: string; direccion?: string; comuna?: string };
  lineas: { nombre: string; cantidad: number; precio: number; descuento?: number; monto: number }[];
  neto: number;
  exento: number;
  iva: number;
  total: number;
  /** El <TED>…</TED> literal del XML firmado. */
  ted: string;
  resolucion: { fecha: string; numero: number };
  ambiente: "certificacion" | "produccion";
}

export const NOMBRE_DOC: Record<number, string> = {
  33: "FACTURA ELECTRÓNICA",
  34: "FACTURA NO AFECTA O EXENTA ELECTRÓNICA",
  39: "BOLETA ELECTRÓNICA",
  41: "BOLETA NO AFECTA O EXENTA ELECTRÓNICA",
  52: "GUÍA DE DESPACHO ELECTRÓNICA",
  56: "NOTA DE DÉBITO ELECTRÓNICA",
  61: "NOTA DE CRÉDITO ELECTRÓNICA",
};

const pesos = (n: number): string => "$" + Math.round(n).toLocaleString("es-CL");
const dia = (f: string): string => { const [a, m, d] = f.split("-"); return `${d}-${m}-${a}`; };

/**
 * El timbre como PDF417.
 *
 * Nivel de corrección 5 y 18 columnas: el TED ronda los 800 bytes porque lleva el
 * CAF completo adentro, y con menos corrección un pliegue del papel lo vuelve
 * ilegible. La altura de fila (scaleY) va al triple del ancho de módulo: un PDF417
 * demasiado aplastado se lee mal, y el del SII hay que poder escanearlo del papel.
 * Compruébalo escaneando de verdad antes de las muestras de impresión.
 */
export async function timbrePdf417(ted: string): Promise<Buffer> {
  // `columns` y `eclevel` son de PDF417 y no están en el tipo genérico de la
  // librería, aunque sí en su API. El cast es por los tipos, no por el comportamiento.
  const opciones = {
    bcid: "pdf417",
    text: ted,
    columns: 18,
    eclevel: 5,
    scaleX: 2,
    scaleY: 3,
    paddingwidth: 0,
    paddingheight: 0,
  } as unknown as Parameters<typeof toBuffer>[0];
  return (await toBuffer(opciones)) as unknown as Buffer;
}

/** Arma el PDF y lo devuelve entero. */
export async function pdfDocumento(d: DatosImpresion): Promise<Buffer> {
  const timbre = await timbrePdf417(d.ted);
  const doc = new PDFDocument({ size: "LETTER", margin: 40, info: { Title: `${NOMBRE_DOC[d.tipo] || "DTE"} ${d.folio}` } });

  const trozos: Buffer[] = [];
  doc.on("data", (t: Buffer) => trozos.push(t));
  const listo = new Promise<Buffer>((ok) => doc.on("end", () => ok(Buffer.concat(trozos))));

  const ancho = doc.page.width - 80;
  const izq = 40;
  const ROJO = "#B3261E";

  // ---- Encabezado: emisor a la izquierda, recuadro rojo a la derecha ----
  const cajaX = izq + ancho - 230;
  doc.font("Helvetica-Bold").fontSize(13).text(d.emisor.razon, izq, 46, { width: ancho - 250 });
  doc.font("Helvetica").fontSize(9).fillColor("#444")
    .text(d.emisor.giro, { width: ancho - 250 })
    .text(`${d.emisor.direccion}, ${d.emisor.comuna}${d.emisor.ciudad ? ", " + d.emisor.ciudad : ""}`, { width: ancho - 250 });

  doc.rect(cajaX, 42, 230, 72).lineWidth(2).stroke(ROJO);
  doc.fillColor(ROJO).font("Helvetica-Bold").fontSize(11)
    .text(`R.U.T.: ${d.emisor.rut}`, cajaX, 52, { width: 230, align: "center" })
    .fontSize(10).text(NOMBRE_DOC[d.tipo] || `DOCUMENTO ${d.tipo}`, cajaX + 6, 70, { width: 218, align: "center" })
    .fontSize(13).text(`N° ${d.folio}`, cajaX, 90, { width: 230, align: "center" });
  doc.fillColor("#000").font("Helvetica").fontSize(8)
    .text("S.I.I. - CHILE", cajaX, 118, { width: 230, align: "center" });

  if (d.ambiente === "certificacion") {
    doc.fillColor(ROJO).font("Helvetica-Bold").fontSize(9)
      .text("DOCUMENTO DE PRUEBA — AMBIENTE DE CERTIFICACIÓN", izq, 128, { width: ancho, align: "center" });
    doc.fillColor("#000");
  }

  // ---- Fecha y receptor ----
  let y = 150;
  doc.font("Helvetica").fontSize(9).text(`Fecha de emisión: ${dia(d.fecha)}`, izq, y);
  y += 18;

  doc.rect(izq, y, ancho, 58).lineWidth(0.5).strokeColor("#999").stroke();
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#000").text("SEÑOR(ES)", izq + 8, y + 7);
  doc.font("Helvetica").text(`${d.receptor.razon}   ·   R.U.T.: ${d.receptor.rut}`, izq + 80, y + 7, { width: ancho - 90 });
  if (d.receptor.giro) { doc.font("Helvetica-Bold").text("GIRO", izq + 8, y + 24); doc.font("Helvetica").text(d.receptor.giro, izq + 80, y + 24, { width: ancho - 90 }); }
  if (d.receptor.direccion) {
    doc.font("Helvetica-Bold").text("DIRECCIÓN", izq + 8, y + 40);
    doc.font("Helvetica").text(`${d.receptor.direccion}${d.receptor.comuna ? ", " + d.receptor.comuna : ""}`, izq + 80, y + 40, { width: ancho - 90 });
  }
  y += 72;

  // ---- Detalle ----
  const cols = [izq + 6, izq + ancho - 230, izq + ancho - 160, izq + ancho - 80];
  doc.rect(izq, y, ancho, 18).fill("#EEE");
  doc.fillColor("#000").font("Helvetica-Bold").fontSize(8.5)
    .text("DESCRIPCIÓN", cols[0], y + 5)
    .text("CANTIDAD", cols[1], y + 5, { width: 60, align: "right" })
    .text("P. UNITARIO", cols[2], y + 5, { width: 70, align: "right" })
    .text("TOTAL", cols[3], y + 5, { width: 74, align: "right" });
  y += 20;

  doc.font("Helvetica").fontSize(8.5);
  for (const l of d.lineas) {
    if (y > doc.page.height - 230) { doc.addPage(); y = 50; }
    const alto = Math.max(14, doc.heightOfString(l.nombre, { width: cols[1] - cols[0] - 10 }));
    doc.text(l.nombre, cols[0], y, { width: cols[1] - cols[0] - 10 })
      .text(String(l.cantidad), cols[1], y, { width: 60, align: "right" })
      .text(pesos(l.precio), cols[2], y, { width: 70, align: "right" })
      .text(pesos(l.monto), cols[3], y, { width: 74, align: "right" });
    y += alto + 4;
    doc.moveTo(izq, y - 2).lineTo(izq + ancho, y - 2).lineWidth(0.3).strokeColor("#DDD").stroke();
  }

  // ---- Totales ----
  y += 10;
  const totX = izq + ancho - 220;
  const fila = (etiqueta: string, valor: number, fuerte = false) => {
    doc.font(fuerte ? "Helvetica-Bold" : "Helvetica").fontSize(fuerte ? 10 : 9).fillColor("#000")
      .text(etiqueta, totX, y, { width: 120, align: "right" })
      .text(pesos(valor), totX + 126, y, { width: 94, align: "right" });
    y += fuerte ? 16 : 14;
  };
  if (d.exento) fila("EXENTO", d.exento);
  if (d.neto) fila("NETO", d.neto);
  if (d.iva) fila("IVA 19%", d.iva);
  doc.moveTo(totX, y).lineTo(izq + ancho, y).lineWidth(0.5).strokeColor("#999").stroke();
  y += 6;
  fila("TOTAL", d.total, true);

  // ---- Timbre ----
  const timbreY = Math.max(y + 20, doc.page.height - 200);
  doc.image(timbre, izq + (ancho - 280) / 2, timbreY, { fit: [280, 110], align: "center" });
  doc.font("Helvetica").fontSize(7.5).fillColor("#333")
    .text("Timbre Electrónico SII", izq, timbreY + 116, { width: ancho, align: "center" })
    .text(`Res. N° ${d.resolucion.numero} de ${dia(d.resolucion.fecha)} — Verifique documento: www.sii.cl`, izq, timbreY + 126, { width: ancho, align: "center" });

  doc.end();
  return listo;
}
