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
export type Formato = "carta" | "termica80";

/**
 * El timbre como PDF417.
 *
 * En hoja carta van 18 columnas. En el rollo de 80 mm van 10, y no por gusto: con
 * 18 columnas el módulo quedaría en 0,18 mm y un cabezal térmico de 203 dpi no
 * resuelve eso — el código se imprime pero no se deja escanear.
 */
export async function timbrePdf417(ted: string, formato: Formato = "carta"): Promise<Buffer> {
  // `columns` y `eclevel` son de PDF417 y no están en el tipo genérico de la
  // librería, aunque sí en su API. El cast es por los tipos, no por el comportamiento.
  const opciones = {
    bcid: "pdf417",
    text: ted,
    columns: formato === "termica80" ? 10 : 18,
    eclevel: 5,
    scaleX: 2,
    // En el rollo la fila va al doble del módulo y no al triple: con 10 columnas el
    // código ya sale alto, y cada milímetro de más es papel botado en cada ticket.
    scaleY: formato === "termica80" ? 2 : 3,
    paddingwidth: 0,
    paddingheight: 0,
  } as unknown as Parameters<typeof toBuffer>[0];
  return (await toBuffer(opciones)) as unknown as Buffer;
}

/** Arma el PDF en el formato que se pida. */
export async function pdfDocumento(d: DatosImpresion, formato: Formato = "carta"): Promise<Buffer> {
  return formato === "termica80" ? pdfTermica(d) : pdfCarta(d);
}

/** Hoja carta: lo que se entrega impreso o por correo. */
async function pdfCarta(d: DatosImpresion): Promise<Buffer> {
  const timbre = await timbrePdf417(d.ted, "carta");
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

/*
 * Rollo térmico de 80 mm.
 *
 * El papel mide 80 mm pero el área que imprime son unos 72: los dos márgenes no
 * son decorativos, son el borde que el cabezal no alcanza.
 *
 * La altura se calcula antes de crear la página porque un PDF necesita saber el
 * tamaño de antemano, y en un rollo continuo no hay "página siguiente": si el
 * cálculo se queda corto, el documento sale cortado.
 */

/** Ancho y alto de un PNG, leídos de su cabecera IHDR. */
function dimensionPng(png: Buffer): { ancho: number; alto: number } {
  return { ancho: png.readUInt32BE(16), alto: png.readUInt32BE(20) };
}

const ANCHO_80 = 226.77;  // 80 mm en puntos
const MARGEN_80 = 10;

async function pdfTermica(d: DatosImpresion): Promise<Buffer> {
  const timbre = await timbrePdf417(d.ted, "termica80");
  const util = ANCHO_80 - MARGEN_80 * 2;

  // La proporción del timbre sale del PNG, no de una estimación.
  const png = dimensionPng(timbre);
  const altoTimbre = Math.round(util * (png.alto / png.ancho));

  /*
   * El alto hay que saberlo antes de crear la página, porque en un rollo continuo
   * no hay "página siguiente". Calcularlo con constantes siempre sobra o falta, así
   * que se dibuja dos veces: la primera sobre una página larga y desechable, solo
   * para ver dónde termina el contenido, y la segunda del porte exacto.
   *
   * Cuesta unos milisegundos y ahorra centímetros de papel en cada ticket.
   */
  const medir = new PDFDocument({ size: [ANCHO_80, 2000], margin: MARGEN_80 });
  medir.on("data", () => { /* se descarta */ });
  const fin = dibujarTermica(medir, d, timbre, altoTimbre);
  medir.end();

  const doc = new PDFDocument({
    size: [ANCHO_80, Math.ceil(fin + MARGEN_80)], margin: MARGEN_80,
    info: { Title: `${NOMBRE_DOC[d.tipo] || "DTE"} ${d.folio}` },
  });
  const trozos: Buffer[] = [];
  doc.on("data", (t: Buffer) => trozos.push(t));
  const listo = new Promise<Buffer>((ok) => doc.on("end", () => ok(Buffer.concat(trozos))));
  dibujarTermica(doc, d, timbre, altoTimbre);
  doc.end();
  return listo;
}

/** Dibuja el ticket y devuelve dónde terminó, para poder medirlo antes de imprimirlo. */
function dibujarTermica(doc: PDFKit.PDFDocument, d: DatosImpresion, timbre: Buffer, altoTimbre: number): number {
  const util = ANCHO_80 - MARGEN_80 * 2;
  const centro = { width: util, align: "center" as const };
  let y = MARGEN_80;
  const salto = (n: number) => { y += n; };

  // ---- Emisor ----
  doc.font("Helvetica-Bold").fontSize(10).text(d.emisor.razon, MARGEN_80, y, centro);
  y = doc.y;
  doc.font("Helvetica").fontSize(7).fillColor("#333")
    .text(d.emisor.giro, MARGEN_80, y, centro)
    .text(`${d.emisor.direccion}, ${d.emisor.comuna}`, MARGEN_80, doc.y, centro);
  y = doc.y + 6;

  // ---- Recuadro del documento ----
  doc.rect(MARGEN_80, y, util, 44).lineWidth(1).strokeColor("#000").stroke();
  doc.fillColor("#000").font("Helvetica-Bold").fontSize(8)
    .text(`R.U.T.: ${d.emisor.rut}`, MARGEN_80, y + 5, centro)
    .fontSize(7.5).text(NOMBRE_DOC[d.tipo] || `DOCUMENTO ${d.tipo}`, MARGEN_80 + 2, y + 17, { width: util - 4, align: "center" })
    .fontSize(10).text(`N° ${d.folio}`, MARGEN_80, y + 29, centro);
  y += 50;

  if (d.ambiente === "certificacion") {
    doc.font("Helvetica-Bold").fontSize(7).text("DOCUMENTO DE PRUEBA", MARGEN_80, y, centro);
    y = doc.y + 2;
  }

  doc.font("Helvetica").fontSize(7).text(dia(d.fecha), MARGEN_80, y, centro);
  y = doc.y + 6;

  // ---- Receptor: en la boleta al consumidor final no va ----
  if (d.receptor.rut !== "66666666-6") {
    doc.moveTo(MARGEN_80, y).lineTo(MARGEN_80 + util, y).lineWidth(0.5).strokeColor("#999").stroke();
    salto(4);
    doc.font("Helvetica-Bold").fontSize(7).text(d.receptor.razon, MARGEN_80, y, { width: util });
    doc.font("Helvetica").text(`R.U.T.: ${d.receptor.rut}`, MARGEN_80, doc.y, { width: util });
    if (d.receptor.giro) doc.text(d.receptor.giro, MARGEN_80, doc.y, { width: util });
    if (d.receptor.direccion) doc.text(`${d.receptor.direccion}${d.receptor.comuna ? ", " + d.receptor.comuna : ""}`, MARGEN_80, doc.y, { width: util });
    y = doc.y + 4;
  }

  // ---- Detalle ----
  doc.moveTo(MARGEN_80, y).lineTo(MARGEN_80 + util, y).lineWidth(0.5).strokeColor("#000").stroke();
  salto(4);
  for (const l of d.lineas) {
    doc.font("Helvetica").fontSize(7).fillColor("#000").text(l.nombre, MARGEN_80, y, { width: util });
    y = doc.y;
    doc.fontSize(7)
      .text(`${l.cantidad} x ${pesos(l.precio)}`, MARGEN_80, y, { width: util / 2 })
      .text(pesos(l.monto), MARGEN_80 + util / 2, y, { width: util / 2, align: "right" });
    y = doc.y + 3;
  }

  // ---- Totales ----
  doc.moveTo(MARGEN_80, y).lineTo(MARGEN_80 + util, y).lineWidth(0.5).strokeColor("#000").stroke();
  salto(5);
  const totalFila = (etiqueta: string, valor: number, fuerte = false) => {
    doc.font(fuerte ? "Helvetica-Bold" : "Helvetica").fontSize(fuerte ? 9 : 7.5)
      .text(etiqueta, MARGEN_80, y, { width: util / 2 })
      .text(pesos(valor), MARGEN_80 + util / 2, y, { width: util / 2, align: "right" });
    y = doc.y + 2;
  };
  if (d.exento) totalFila("EXENTO", d.exento);
  if (d.neto) totalFila("NETO", d.neto);
  if (d.iva) totalFila("IVA 19%", d.iva);
  totalFila("TOTAL", d.total, true);

  // ---- Timbre ----
  y += 8;
  doc.image(timbre, MARGEN_80, y, { fit: [util, altoTimbre], align: "center" });
  y += altoTimbre + 4;
  doc.font("Helvetica").fontSize(6).fillColor("#333")
    .text("Timbre Electrónico SII", MARGEN_80, y, centro)
    .text(`Res. N° ${d.resolucion.numero} de ${dia(d.resolucion.fecha)}`, MARGEN_80, doc.y, centro)
    .text("Verifique documento: www.sii.cl", MARGEN_80, doc.y, centro);

  return doc.y;
}
