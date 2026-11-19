import { Caf } from "./caf";
import { timbre, esc, instanteSii } from "./ted";
import { rutPlano } from "./caf";

/*
 * Arma el <Documento> de un DTE. El orden de los elementos no es decorativo: el
 * esquema del SII los declara como secuencia, así que un elemento fuera de lugar es
 * un rechazo. Por eso acá se construye como texto, en orden, y no con un DOM.
 *
 * Cubre factura afecta (33) y boleta (39), que se diferencian en algo importante:
 * en la factura los precios son netos y el IVA se suma; en la boleta los precios ya
 * vienen con IVA incluido y el neto se despeja hacia atrás.
 */

export const TASA_IVA = 19;

export interface Emisor {
  rut: string;
  razon: string;
  giro: string;
  /** Código de actividad económica. */
  acteco?: number;
  direccion: string;
  comuna: string;
  ciudad?: string;
  /** Código de sucursal del SII, cuando el documento se emite desde una. */
  codigoSucursal?: string;
}

export interface Receptor {
  rut: string;
  razon: string;
  giro?: string;
  direccion?: string;
  comuna?: string;
  ciudad?: string;
}

export interface Linea {
  nombre: string;
  descripcion?: string;
  cantidad: number;
  /** Neto en factura, con IVA incluido en boleta. */
  precio: number;
  unidad?: string;
  codigo?: string;
  /** Descuento en pesos sobre la línea. */
  descuento?: number;
  exento?: boolean;
}

export interface Referencia {
  tipo: number | string;
  folio: string | number;
  fecha: string;
  /** 1 anula, 2 corrige texto, 3 corrige monto. */
  codigo?: number;
  razon?: string;
}

export interface DatosDoc {
  tipo: number;
  folio: number;
  /** YYYY-MM-DD */
  fecha: string;
  emisor: Emisor;
  receptor: Receptor;
  lineas: Linea[];
  referencias?: Referencia[];
  /** 1 contado, 2 crédito, 3 sin costo. */
  formaPago?: number;
  vence?: string;
}

export interface Totales {
  neto: number;
  exento: number;
  iva: number;
  total: number;
}

const el = (t: string, v: string | number | undefined | null): string =>
  v === undefined || v === null || v === "" ? "" : `<${t}>${typeof v === "string" ? esc(v) : v}</${t}>`;

const corta = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Lo que vale una línea, ya con su descuento aplicado. */
const montoLinea = (l: Linea): number => Math.round(l.cantidad * l.precio - (l.descuento || 0));

/**
 * Totales del documento.
 *
 * En la boleta el IVA va incluido en los precios, así que el neto se despeja y el
 * IVA es la diferencia: así nunca se descuadra por un peso de redondeo.
 */
export function totalesDe(tipo: number, lineas: Linea[]): Totales {
  const afecto = lineas.filter((l) => !l.exento).reduce((a, l) => a + montoLinea(l), 0);
  const exento = lineas.filter((l) => l.exento).reduce((a, l) => a + montoLinea(l), 0);

  if (tipo === 39 || tipo === 41) {
    const neto = Math.round(afecto / (1 + TASA_IVA / 100));
    return { neto, exento, iva: afecto - neto, total: afecto + exento };
  }
  const iva = Math.round((afecto * TASA_IVA) / 100);
  return { neto: afecto, exento, iva, total: afecto + exento + iva };
}

/** El identificador del documento, que es al que apunta la firma. */
export const idDocumento = (tipo: number, folio: number): string => `F${folio}T${tipo}`;

function encabezado(d: DatosDoc, t: Totales): string {
  const boleta = d.tipo === 39 || d.tipo === 41;
  const e = d.emisor, r = d.receptor;

  const idDoc = "<IdDoc>"
    + el("TipoDTE", d.tipo) + el("Folio", d.folio) + el("FchEmis", d.fecha)
    + el("FmaPago", d.formaPago) + el("FchVenc", d.vence)
    + "</IdDoc>";

  // En boleta el SII usa RznSocEmisor y GiroEmisor; en factura, RznSoc y GiroEmis.
  const emisor = "<Emisor>"
    + el("RUTEmisor", rutPlano(e.rut))
    + el(boleta ? "RznSocEmisor" : "RznSoc", corta(e.razon, 100))
    + el(boleta ? "GiroEmisor" : "GiroEmis", corta(e.giro, 80))
    + (boleta ? "" : el("Acteco", e.acteco))
    + el("CdgSIISucur", e.codigoSucursal)
    + el("DirOrigen", corta(e.direccion, 60))
    + el("CmnaOrigen", corta(e.comuna, 20))
    + el("CiudadOrigen", e.ciudad ? corta(e.ciudad, 20) : "")
    + "</Emisor>";

  const receptor = "<Receptor>"
    + el("RUTRecep", rutPlano(r.rut))
    + el("RznSocRecep", corta(r.razon, 100))
    + (boleta ? "" : el("GiroRecep", r.giro ? corta(r.giro, 40) : ""))
    + el("DirRecep", r.direccion ? corta(r.direccion, 70) : "")
    + el("CmnaRecep", r.comuna ? corta(r.comuna, 20) : "")
    + el("CiudadRecep", r.ciudad ? corta(r.ciudad, 20) : "")
    + "</Receptor>";

  const totales = "<Totales>"
    + el("MntNeto", t.neto || "")
    + el("MntExe", t.exento || "")
    + (t.iva ? el("TasaIVA", TASA_IVA) + el("IVA", t.iva) : "")
    + el("MntTotal", t.total)
    + "</Totales>";

  return "<Encabezado>" + idDoc + emisor + receptor + totales + "</Encabezado>";
}

function detalle(d: DatosDoc): string {
  const boleta = d.tipo === 39 || d.tipo === 41;
  return d.lineas.map((l, i) => "<Detalle>"
    + el("NroLinDet", i + 1)
    + (l.codigo ? `<CdgItem><TpoCodigo>INT1</TpoCodigo><VlrCodigo>${esc(corta(l.codigo, 35))}</VlrCodigo></CdgItem>` : "")
    + (l.exento ? el("IndExe", 1) : "")
    + el("NmbItem", corta(l.nombre, 80))
    + el("DscItem", l.descripcion ? corta(l.descripcion, 1000) : "")
    + el("QtyItem", l.cantidad)
    + el("UnmdItem", l.unidad ? corta(l.unidad, 4) : "")
    + el("PrcItem", l.precio)
    + el("DescuentoMonto", l.descuento || "")
    + el("MontoItem", montoLinea(l))
    + "</Detalle>").join("")
    + (boleta ? "" : ""); // el detalle no cambia entre ambos; la diferencia está en los totales
}

function referencias(d: DatosDoc): string {
  return (d.referencias || []).slice(0, 40).map((r, i) => "<Referencia>"
    + el("NroLinRef", i + 1)
    + el("TpoDocRef", String(r.tipo))
    + el("FolioRef", String(r.folio))
    + el("FchRef", r.fecha)
    + el("CodRef", r.codigo)
    + el("RazonRef", r.razon ? corta(r.razon, 90) : "")
    + "</Referencia>").join("");
}

/**
 * Arma el <DTE> completo con su timbre, listo para firmar.
 *
 * Devuelve también los totales y el id, que el que llama necesita para guardar el
 * documento y para firmarlo.
 */
export function armarDocumento(d: DatosDoc, caf: Caf, ahora: Date = new Date()): {
  xml: string; id: string; totales: Totales; ted: string;
} {
  if (!d.lineas.length) throw new Error("El documento no tiene líneas de detalle.");
  if (d.lineas.length > 60) throw new Error("El SII acepta hasta 60 líneas por documento.");

  const t = totalesDe(d.tipo, d.lineas);
  if (t.total <= 0) throw new Error("El total del documento tiene que ser mayor que cero.");

  const { ted } = timbre(caf, {
    tipo: d.tipo, folio: d.folio, fecha: d.fecha,
    rutEmisor: d.emisor.rut, rutReceptor: d.receptor.rut,
    razonReceptor: d.receptor.razon, monto: t.total, primerItem: d.lineas[0].nombre,
  }, ahora);

  const id = idDocumento(d.tipo, d.folio);
  const xml = '<DTE version="1.0" xmlns="http://www.sii.cl/SiiDte">'
    + `<Documento ID="${id}">`
    + encabezado(d, t)
    + detalle(d)
    + referencias(d)
    + ted
    + el("TmstFirma", instanteSii(ahora))
    + "</Documento></DTE>";

  return { xml, id, totales: t, ted };
}
