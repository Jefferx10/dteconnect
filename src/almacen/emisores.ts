import { consulta, anotar } from "./db";
import { cifrar, descifrar } from "./cifrado";
import { Certificado, leerCertificado, diasDeVida } from "../sii/cert";
import { leerCaf, rutPlano, rutValido } from "../sii/caf";
import { ErrorDatos, NoExiste } from "./errores";
import { guardarCaf, foliosDisponibles, Disponibles } from "./folios";
import { Ambiente, olvidarToken } from "../sii/transporte";

/*
 * Los emisores: quién puede emitir, con qué certificado y con qué folios.
 *
 * El .pfx, su clave y el XML de cada CAF se guardan cifrados. En claro solo quedan
 * los metadatos —titular, vencimiento, rangos— que son los que la pantalla necesita
 * mostrar y que no sirven para firmar nada.
 *
 * Abrir un .pfx cuesta (derivación de clave), así que lo ya abierto se guarda en
 * memoria del proceso. Se pierde cuando la instancia muere, que es lo que se quiere.
 */

const abiertos = new Map<string, Certificado>();

export interface Emisor {
  rut: string;
  razon: string;
  giro: string;
  acteco: number | null;
  direccion: string;
  comuna: string;
  ciudad: string | null;
  resolucionFecha: string;
  resolucionNumero: number;
  ambiente: Ambiente;
  activo: boolean;
  cert: { titular: string; vence: number; dias: number } | null;
}

export interface EmisorConFolios extends Emisor {
  folios: Disponibles[];
}

const fecha = (d: Date | string | null): string =>
  !d ? "" : (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

function aEmisor(f: any): Emisor {
  return {
    rut: f.rut, razon: f.razon, giro: f.giro, acteco: f.acteco,
    direccion: f.direccion, comuna: f.comuna, ciudad: f.ciudad,
    resolucionFecha: fecha(f.resolucion_fecha), resolucionNumero: f.resolucion_numero,
    ambiente: f.ambiente, activo: f.activo,
    cert: f.cert_titular
      ? {
        titular: f.cert_titular,
        vence: new Date(f.cert_vence).getTime(),
        dias: Math.floor((new Date(f.cert_vence).getTime() - Date.now()) / 86400000),
      }
      : null,
  };
}

const CAMPOS = `rut, razon, giro, acteco, direccion, comuna, ciudad,
  resolucion_fecha, resolucion_numero, ambiente, activo, cert_titular, cert_vence`;

export async function listarEmisores(): Promise<EmisorConFolios[]> {
  const filas = await consulta(`select ${CAMPOS} from emisores order by razon`);
  return Promise.all(filas.map(async (f) => ({ ...aEmisor(f), folios: await foliosDisponibles(f.rut) })));
}

export async function verEmisor(rut: string): Promise<EmisorConFolios | null> {
  const r = await consulta(`select ${CAMPOS} from emisores where rut = $1`, [rutPlano(rut)]);
  if (!r.length) return null;
  return { ...aEmisor(r[0]), folios: await foliosDisponibles(r[0].rut) };
}

export interface DatosEmisor {
  rut: string; razon: string; giro: string; acteco?: number;
  direccion: string; comuna: string; ciudad?: string;
  resolucionFecha: string; resolucionNumero?: number;
  ambiente?: Ambiente;
}

/** Crea o actualiza un emisor. No toca el certificado, los folios ni el interruptor. */
export async function guardarEmisor(d: DatosEmisor): Promise<Emisor> {
  const rut = rutPlano(d.rut);
  if (!rutValido(rut)) throw new ErrorDatos(`El RUT ${d.rut} no es válido: el dígito verificador no corresponde.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.resolucionFecha)) throw new ErrorDatos("La fecha de la resolución debe ser YYYY-MM-DD.");
  for (const [campo, valor] of [["la razón social", d.razon], ["el giro", d.giro], ["la dirección", d.direccion], ["la comuna", d.comuna]]) {
    if (!String(valor || "").trim()) throw new ErrorDatos(`Falta ${campo}.`);
  }
  const ambiente: Ambiente = d.ambiente === "produccion" ? "produccion" : "certificacion";

  const r = await consulta(
    `insert into emisores (rut, razon, giro, acteco, direccion, comuna, ciudad,
                           resolucion_fecha, resolucion_numero, ambiente)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (rut) do update set
       razon = excluded.razon, giro = excluded.giro, acteco = excluded.acteco,
       direccion = excluded.direccion, comuna = excluded.comuna, ciudad = excluded.ciudad,
       resolucion_fecha = excluded.resolucion_fecha, resolucion_numero = excluded.resolucion_numero,
       ambiente = excluded.ambiente, actualizado = now()
     returning ${CAMPOS}`,
    [rut, d.razon.trim(), d.giro.trim(), d.acteco ?? null, d.direccion.trim(), d.comuna.trim(),
      d.ciudad?.trim() || null, d.resolucionFecha, Math.max(0, Math.round(d.resolucionNumero ?? 0)), ambiente],
  );
  await anotar("emisor.guardar", { emisor: rut, detalle: d.razon });
  return aEmisor(r[0]);
}

/**
 * Carga el certificado digital.
 *
 * Se abre acá mismo antes de guardarlo: más vale rechazarlo ahora, con un mensaje
 * claro, que descubrir en la primera emisión que la clave no era.
 */
export async function guardarCertificado(rut: string, pfx: Buffer, clave: string): Promise<{ titular: string; vence: number; dias: number }> {
  const r = rutPlano(rut);
  if (!(await consulta("select 1 from emisores where rut = $1", [r])).length) {
    throw new NoExiste("Primero guarda los datos del emisor.");
  }
  if (!clave) throw new ErrorDatos("Falta la clave del certificado.");

  let cert: Certificado;
  try { cert = leerCertificado(pfx, clave); }
  catch (e: any) { throw new ErrorDatos(e?.message || "No se pudo abrir el certificado."); }
  const dias = diasDeVida(cert);
  if (dias < 0) throw new ErrorDatos(`Ese certificado venció el ${cert.vence.toLocaleDateString("es-CL")}.`);

  await consulta(
    `update emisores set cert_pfx = $2, cert_clave = $3, cert_titular = $4,
            cert_vence = $5, cert_subido = now(), actualizado = now()
      where rut = $1`,
    [r, cifrar(pfx), cifrar(Buffer.from(clave, "utf8")), cert.rut, new Date(cert.vence)],
  );

  abiertos.delete(r);
  olvidarToken(); // el token del SII se pidió con el certificado anterior
  await anotar("certificado.cargar", { emisor: r, detalle: `titular ${cert.rut}, vence en ${dias} días` });
  return { titular: cert.rut, vence: cert.vence.getTime(), dias };
}

/** El certificado de un emisor, listo para firmar. */
export async function certificadoDe(rut: string): Promise<Certificado> {
  const r = rutPlano(rut);
  const guardado = abiertos.get(r);
  if (guardado) return guardado;

  const f = await consulta<{ cert_pfx: Buffer; cert_clave: Buffer; cert_vence: Date }>(
    "select cert_pfx, cert_clave, cert_vence from emisores where rut = $1", [r],
  );
  if (!f.length || !f[0].cert_pfx) throw new Error(`El emisor ${r} no tiene certificado cargado.`);
  if (new Date(f[0].cert_vence).getTime() < Date.now()) {
    throw new Error(`El certificado de ${r} venció el ${new Date(f[0].cert_vence).toLocaleDateString("es-CL")}. Hay que renovarlo antes de emitir.`);
  }

  const cert = leerCertificado(descifrar(f[0].cert_pfx), descifrar(f[0].cert_clave).toString("utf8"));
  abiertos.set(r, cert);
  return cert;
}

/** Carga un CAF. Valida que sea del mismo RUT antes de guardarlo. */
export async function cargarCaf(rut: string, xml: Buffer) {
  const r = rutPlano(rut);
  const caf = leerCaf(xml.toString("utf8"));
  if (caf.rutEmisor !== r) throw new ErrorDatos(`Ese CAF es de ${caf.rutEmisor}, no de ${r}.`);
  const guardado = await guardarCaf(r, caf, cifrar(xml));
  await anotar("caf.cargar", { emisor: r, detalle: `tipo ${caf.tipo}, folios ${caf.desde}-${caf.hasta}` });
  return guardado;
}

/** El interruptor. Un emisor sin certificado o sin folios no se puede encender. */
export async function activarEmisor(rut: string, activo: boolean): Promise<boolean> {
  const r = rutPlano(rut);
  const e = await verEmisor(r);
  if (!e) throw new NoExiste("Ese emisor no existe.");

  if (activo) {
    if (!e.cert) throw new ErrorDatos("Falta cargar el certificado digital.");
    if (e.cert.dias < 0) throw new ErrorDatos("El certificado está vencido.");
    if (!e.folios.some((f) => f.quedan > 0)) throw new ErrorDatos("No hay folios cargados.");
  }

  await consulta("update emisores set activo = $2, actualizado = now() where rut = $1", [r, activo]);
  await anotar("emisor.activar", { emisor: r, detalle: activo ? "encendido" : "apagado" });
  return activo;
}

/** Para las pruebas y para cuando se reemplaza un certificado en caliente. */
export const olvidarCertificados = (): void => { abiertos.clear(); };
