import { consulta, enTransaccion, anotar } from "./almacen/db";
import { tomarFolio, marcarFolio, cafDeFolio } from "./almacen/folios";
import { certificadoDe, verEmisor } from "./almacen/emisores";
import { ErrorDatos, NoExiste } from "./almacen/errores";
import { armarDocumento, DatosDoc, Linea, Referencia, totalesDe } from "./sii/documento";
import { firmarXml } from "./sii/firma";
import { armarSobre, aLatin1, RUT_SII } from "./sii/envio";
import { enviar as enviarAlSii, estado as estadoEnSii, Ambiente } from "./sii/transporte";
import { rutPlano, rutValido } from "./sii/caf";

/*
 * Emitir un documento, de principio a fin.
 *
 * El orden importa y no es el obvio:
 *
 *  1. Se valida todo lo que se pueda **antes** de tocar un folio. Un folio gastado
 *     en un documento que ni siquiera se podía armar es un folio perdido, y los
 *     folios perdidos hay que informarlos al SII.
 *  2. El folio se toma y el documento se registra dentro de una transacción corta.
 *  3. El armado, la firma y el envío ocurren **fuera** de esa transacción. Una
 *     llamada de red que tarda minutos no puede tener bloqueado el rango de folios
 *     mientras las demás emisiones esperan en fila.
 *  4. Si algo falla después de tomar el folio, el folio queda anulado o pendiente,
 *     según si alcanzó a salir o no, pero nunca vuelve al rango.
 */

export interface PeticionEmision {
  emisor: string;
  tipo: number;
  receptor: { rut: string; razon: string; giro?: string; direccion?: string; comuna?: string; ciudad?: string };
  lineas: Linea[];
  fecha?: string;
  referencias?: Referencia[];
  formaPago?: number;
  vence?: string;
  codigoSucursal?: string;
  /** Repetirla devuelve el documento anterior en vez de emitir otro. */
  idempotencia?: string;
}

export interface Documento {
  id: string;
  emisor: string;
  tipo: number;
  folio: number;
  fecha: string;
  receptor: string;
  neto: number;
  exento: number;
  iva: number;
  total: number;
  ambiente: Ambiente;
  estado: string;
  trackId: string | null;
  glosa: string | null;
}

/** Para poder probar la emisión sin el SII al otro lado. */
export interface Transporte {
  enviar: typeof enviarAlSii;
  estado: typeof estadoEnSii;
}
const REAL: Transporte = { enviar: enviarAlSii, estado: estadoEnSii };

const fecha = (d: Date | string): string => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

const aDocumento = (f: any): Documento => ({
  id: String(f.id), emisor: f.emisor_rut, tipo: f.tipo, folio: f.folio, fecha: fecha(f.fecha),
  receptor: f.receptor_rut, neto: f.neto, exento: f.exento, iva: f.iva, total: f.total,
  ambiente: f.ambiente, estado: f.estado, trackId: f.track_id, glosa: f.glosa,
});

const CAMPOS = `id, emisor_rut, tipo, folio, fecha, receptor_rut, neto, exento, iva, total,
  ambiente, estado, track_id, glosa`;

/** Hoy en Chile, que es la fecha que corresponde al documento. */
const hoyChile = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());

/**
 * Todo lo que se puede rechazar sin gastar un folio.
 *
 * Se arma el documento completo con un folio de mentira: si algo no cuadra —una
 * línea sin nombre, un total en cero, demasiadas líneas— revienta acá, antes de
 * tocar el rango real.
 */
function validar(p: PeticionEmision): { fecha: string; total: number } {
  if (!rutValido(p.receptor?.rut || "")) throw new ErrorDatos(`El RUT del receptor (${p.receptor?.rut ?? "vacío"}) no es válido.`);
  if (!String(p.receptor?.razon || "").trim()) throw new ErrorDatos("Falta la razón social del receptor.");
  if (!Array.isArray(p.lineas) || !p.lineas.length) throw new ErrorDatos("El documento no tiene líneas de detalle.");
  if (p.lineas.length > 60) throw new ErrorDatos("El SII acepta hasta 60 líneas por documento.");
  for (const [i, l] of p.lineas.entries()) {
    if (!String(l.nombre || "").trim()) throw new ErrorDatos(`La línea ${i + 1} no tiene nombre.`);
    if (!Number.isFinite(l.cantidad) || l.cantidad <= 0) throw new ErrorDatos(`La línea ${i + 1} tiene una cantidad que no sirve.`);
    if (!Number.isFinite(l.precio) || l.precio < 0) throw new ErrorDatos(`La línea ${i + 1} tiene un precio que no sirve.`);
  }
  const f = p.fecha || hoyChile();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw new ErrorDatos("La fecha debe ser YYYY-MM-DD.");

  const t = totalesDe(p.tipo, p.lineas);
  if (t.total <= 0) throw new ErrorDatos("El total del documento tiene que ser mayor que cero.");
  return { fecha: f, total: t.total };
}

/** Emite un documento. */
export async function emitir(app: string, p: PeticionEmision, trans: Transporte = REAL): Promise<Documento> {
  const rut = rutPlano(p.emisor || "");

  // Repetir la misma clave no emite otra vez: devuelve lo de antes.
  if (p.idempotencia) {
    const previo = await consulta(`select ${CAMPOS} from documentos where app = $1 and idempotencia = $2`, [app, p.idempotencia]);
    if (previo.length) return aDocumento(previo[0]);
  }

  const emisor = await verEmisor(rut);
  if (!emisor) throw new NoExiste(`No hay un emisor con RUT ${rut}.`);
  if (!emisor.activo) throw new ErrorDatos(`El emisor ${rut} está apagado: enciéndelo antes de emitir.`);
  if (!emisor.cert) throw new ErrorDatos(`El emisor ${rut} no tiene certificado cargado.`);

  const { fecha: f } = validar(p);
  const cert = await certificadoDe(rut); // lanza si está vencido

  // --- Transacción corta: el folio y el registro del documento, juntos ---
  const { folio, id } = await enTransaccion(async (c) => {
    const { folio } = await tomarFolio(c, rut, p.tipo, `${app}: ${p.receptor.razon}`.slice(0, 180));
    const t = totalesDe(p.tipo, p.lineas);
    const r = await c.query(
      `insert into documentos (emisor_rut, tipo, folio, fecha, receptor_rut, receptor_razon,
                               neto, exento, iva, total, ambiente, app, idempotencia)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [rut, p.tipo, folio, f, rutPlano(p.receptor.rut), p.receptor.razon,
        t.neto, t.exento, t.iva, t.total, emisor.ambiente, app, p.idempotencia ?? null],
    );
    return { folio, id: String(r.rows[0].id) };
  });

  // --- Fuera de la transacción: armar, firmar y enviar ---
  try {
    const caf = await cafDeFolio(rut, p.tipo, folio);
    const datos: DatosDoc = {
      tipo: p.tipo, folio, fecha: f,
      emisor: {
        rut, razon: emisor.razon, giro: emisor.giro, acteco: emisor.acteco ?? undefined,
        direccion: emisor.direccion, comuna: emisor.comuna, ciudad: emisor.ciudad ?? undefined,
        codigoSucursal: p.codigoSucursal,
      },
      receptor: p.receptor,
      lineas: p.lineas, referencias: p.referencias, formaPago: p.formaPago, vence: p.vence,
    };

    const armado = armarDocumento(datos, caf);
    const firmado = firmarXml(armado.xml, armado.id, "DTE", cert);

    // Se guarda el DTE firmado antes de enviarlo: si el envío falla, se puede
    // reintentar con el mismo documento en vez de quemar otro folio.
    await consulta("update documentos set xml = $2, actualizado = now() where id = $1", [id, Buffer.from(firmado, "utf8")]);

    const r = await enviarDocumento(id, rut, emisor.ambiente, cert, firmado, emisor.resolucionFecha, emisor.resolucionNumero, trans);
    await marcarFolio(rut, p.tipo, folio, "emitido", `track ${r.trackId}`);
    await anotar("documento.emitir", { app, emisor: rut, detalle: `tipo ${p.tipo} folio ${folio}, track ${r.trackId}` });

    return (await verDocumento(id))!;
  } catch (e: any) {
    const mensaje = String(e?.message || e).slice(0, 500);
    await consulta("update documentos set estado = 'error', glosa = $2, actualizado = now() where id = $1", [id, mensaje]);
    // El folio no vuelve al rango. Queda como asignado —no anulado— porque el
    // documento ya está firmado y se puede reintentar tal cual.
    await marcarFolio(rut, p.tipo, folio, "asignado", mensaje);
    await anotar("documento.emitir", { app, emisor: rut, detalle: `tipo ${p.tipo} folio ${folio}: ${mensaje}`, ok: false });
    throw e;
  }
}

/** Mete el DTE firmado en un sobre y lo sube. Se usa también al reintentar. */
async function enviarDocumento(
  id: string, rut: string, ambiente: Ambiente, cert: any, dteFirmado: string,
  resolucionFecha: string, resolucionNumero: number, trans: Transporte,
): Promise<{ trackId: string }> {
  const sobre = armarSobre([dteFirmado], {
    rutEmisor: rut, rutEnvia: cert.rut || rut, rutReceptor: RUT_SII,
    resolucion: { fecha: resolucionFecha, numero: resolucionNumero },
  }, cert);

  const r = await trans.enviar(ambiente, cert, aLatin1(sobre), rut, cert.rut || rut);
  await consulta(
    "update documentos set track_id = $2, estado = 'enviado', glosa = $3, actualizado = now() where id = $1",
    [id, r.trackId, r.glosa || null],
  );
  return { trackId: r.trackId };
}

export async function verDocumento(id: string): Promise<Documento | null> {
  const r = await consulta(`select ${CAMPOS} from documentos where id = $1`, [id]);
  return r.length ? aDocumento(r[0]) : null;
}

/** El XML firmado, tal como se envió. Es lo que se le entrega al receptor. */
export async function xmlDocumento(id: string): Promise<string | null> {
  const r = await consulta<{ xml: Buffer | null }>("select xml from documentos where id = $1", [id]);
  return r.length && r[0].xml ? r[0].xml.toString("utf8") : null;
}

export interface Filtro {
  emisor?: string;
  estado?: string;
  desde?: string;
  limite?: number;
}

export async function listarDocumentos(f: Filtro = {}): Promise<Documento[]> {
  const donde: string[] = [], valores: unknown[] = [];
  if (f.emisor) { valores.push(rutPlano(f.emisor)); donde.push(`emisor_rut = $${valores.length}`); }
  if (f.estado) { valores.push(f.estado); donde.push(`estado = $${valores.length}`); }
  if (f.desde) { valores.push(f.desde); donde.push(`fecha >= $${valores.length}`); }
  valores.push(Math.min(500, Math.max(1, f.limite || 100)));
  return (await consulta(
    `select ${CAMPOS} from documentos
     ${donde.length ? "where " + donde.join(" and ") : ""}
     order by id desc limit $${valores.length}`, valores,
  )).map(aDocumento);
}

/**
 * Pregunta al SII cómo le fue a un documento ya enviado y guarda la respuesta.
 *
 * Se llama desde el trabajo de seguimiento, no desde la petición que emite: el SII
 * puede tardar minutos y nadie va a esperar con la conexión abierta.
 */
export async function actualizarEstado(id: string, trans: Transporte = REAL): Promise<Documento | null> {
  const r = await consulta<any>("select emisor_rut, track_id, ambiente, estado from documentos where id = $1", [id]);
  if (!r.length) return null;
  const d = r[0];
  if (!d.track_id || d.estado !== "enviado") return verDocumento(id);

  try {
    const cert = await certificadoDe(d.emisor_rut);
    const e = await trans.estado(d.ambiente, cert, d.emisor_rut, d.track_id);
    if (e.resultado === "procesando") {
      await consulta("update documentos set glosa = $2, actualizado = now() where id = $1", [id, e.glosa || e.estado]);
    } else {
      await consulta(
        "update documentos set estado = $2, glosa = $3, actualizado = now() where id = $1",
        [id, e.resultado, `${e.estado}${e.glosa ? ": " + e.glosa : ""}`.slice(0, 500)],
      );
      await anotar("documento.estado", { emisor: d.emisor_rut, detalle: `${id}: ${e.resultado}`, ok: e.resultado !== "rechazado" });
    }
  } catch (err: any) {
    // Que el SII no conteste no cambia el estado del documento: sigue enviado.
    await consulta("update documentos set glosa = $2, actualizado = now() where id = $1",
      [id, `No se pudo consultar: ${String(err?.message || err)}`.slice(0, 500)]);
  }
  return verDocumento(id);
}

/*
 * Los datos para la representación impresa salen del **documento firmado**, no de
 * la petición que lo originó: lo que se imprime tiene que ser exactamente lo que
 * se timbró y se envió, no lo que alguien quiso enviar.
 */

const entre = (xml: string, t: string): string =>
  xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? "";
const desescapar = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export async function datosImpresion(id: string) {
  const r = await consulta<any>(
    `select d.*, e.razon, e.giro, e.direccion, e.comuna, e.ciudad,
            e.resolucion_fecha, e.resolucion_numero
       from documentos d join emisores e on e.rut = d.emisor_rut
      where d.id = $1`, [id],
  );
  if (!r.length) throw new NoExiste(`No hay un documento con id ${id}.`);
  const d = r[0];
  if (!d.xml) throw new ErrorDatos("Ese documento todavía no está firmado.");
  const xml = (d.xml as Buffer).toString("utf8");

  const ted = xml.match(/<TED[\s\S]*?<\/TED>/)?.[0];
  if (!ted) throw new ErrorDatos("El documento guardado no trae su timbre.");

  const lineas = [...xml.matchAll(/<Detalle>([\s\S]*?)<\/Detalle>/g)].map((m) => {
    const b = m[1];
    return {
      nombre: desescapar(entre(b, "NmbItem")),
      cantidad: Number(entre(b, "QtyItem") || 1),
      precio: Number(entre(b, "PrcItem") || 0),
      descuento: Number(entre(b, "DescuentoMonto") || 0),
      monto: Number(entre(b, "MontoItem") || 0),
    };
  });

  return {
    tipo: d.tipo, folio: d.folio, fecha: fecha(d.fecha),
    emisor: {
      rut: d.emisor_rut, razon: d.razon, giro: d.giro,
      direccion: d.direccion, comuna: d.comuna, ciudad: d.ciudad,
    },
    receptor: {
      rut: d.receptor_rut, razon: d.receptor_razon,
      giro: desescapar(entre(xml, "GiroRecep")) || undefined,
      direccion: desescapar(entre(xml, "DirRecep")) || undefined,
      comuna: desescapar(entre(xml, "CmnaRecep")) || undefined,
    },
    lineas,
    neto: d.neto, exento: d.exento, iva: d.iva, total: d.total,
    ted,
    resolucion: { fecha: fecha(d.resolucion_fecha), numero: d.resolucion_numero },
    ambiente: d.ambiente as Ambiente,
  };
}

/** Busca un documento por emisor, tipo y folio, que es como lo conoce quien lo pidió. */
export async function documentoPorFolio(emisor: string, tipo: number, folio: number): Promise<Documento | null> {
  const r = await consulta(
    `select ${CAMPOS} from documentos where emisor_rut = $1 and tipo = $2 and folio = $3`,
    [rutPlano(emisor), tipo, folio],
  );
  return r.length ? aDocumento(r[0]) : null;
}
