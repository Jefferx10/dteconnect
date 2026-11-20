import { ruta, archivoDe, malaPeticion, noEncontrado, prohibido, ErrorHttp } from "./http";
import { appPuedeCon } from "../almacen/apps";
import {
  listarEmisores, verEmisor, guardarEmisor, guardarCertificado, cargarCaf, activarEmisor,
} from "../almacen/emisores";
import { listarApps, crearApp, renovarLlave, activarApp } from "../almacen/apps";
import { foliosDisponibles } from "../almacen/folios";
import { consulta } from "../almacen/db";
import { ErrorDatos, NoExiste, SinFolios } from "../almacen/errores";
import { emitir, verDocumento, xmlDocumento, listarDocumentos, actualizarEstado, datosImpresion, documentoPorFolio } from "../emision";
import { pdfDocumento, Formato } from "../pdf/impresa";
import { pdfTermico } from "../pdf/termica";

/*
 * Las rutas.
 *
 * Tres niveles de acceso: público (solo salud), llave de aplicación (lo que usan
 * Patiolo y los demás programas) y llave de administración (crear aplicaciones y
 * cargar material sensible).
 *
 * Cargar un certificado es de administración a propósito: una aplicación comprometida
 * no debería poder reemplazar la firma electrónica de un contribuyente.
 */

/**
 * Traduce los errores del dominio a códigos HTTP.
 *
 * Por tipo, no por el texto del mensaje: adivinar leyendo la frase es frágil, y
 * basta reescribir un mensaje para que un error de datos empiece a salir como falla
 * interna del servidor.
 */
const comoHttp = async <T>(f: () => Promise<T>): Promise<T> => {
  try { return await f(); } catch (e: any) {
    if (e instanceof ErrorHttp) throw e;
    if (e instanceof NoExiste) throw noEncontrado(e.message);
    if (e instanceof ErrorDatos) throw malaPeticion(e.message);
    if (e instanceof SinFolios) throw new ErrorHttp(409, e.message);
    throw e;
  }
};

// ------------------------------------------------------------------ salud

ruta("GET", "/salud", "publica", async () => {
  const [{ n }] = await consulta<{ n: number }>("select count(*)::int n from emisores");
  return { ok: true, emisores: n, version: 1 };
});

// --------------------------------------------------------------- emisores

ruta("GET", "/emisores", "app", async () => ({ emisores: await listarEmisores() }));

ruta("GET", "/emisores/:rut", "app", async ({ params }) => {
  const e = await verEmisor(params.rut);
  if (!e) throw noEncontrado(`No hay un emisor con RUT ${params.rut}.`);
  return e;
});

ruta("GET", "/emisores/:rut/folios", "app", async ({ params }) => {
  const e = await verEmisor(params.rut);
  if (!e) throw noEncontrado(`No hay un emisor con RUT ${params.rut}.`);
  return { rut: e.rut, folios: await foliosDisponibles(e.rut) };
});

ruta("POST", "/emisores", "admin", async ({ cuerpo }) => comoHttp(() => guardarEmisor(cuerpo)));

ruta("POST", "/emisores/:rut/certificado", "admin", async ({ params, cuerpo }) =>
  comoHttp(() => guardarCertificado(params.rut, archivoDe(cuerpo.archivo, "el certificado"), String(cuerpo.clave ?? ""))));

ruta("POST", "/emisores/:rut/caf", "admin", async ({ params, cuerpo }) =>
  comoHttp(() => cargarCaf(params.rut, archivoDe(cuerpo.archivo, "el CAF"))));

ruta("POST", "/emisores/:rut/activo", "admin", async ({ params, cuerpo }) =>
  comoHttp(async () => ({ activo: await activarEmisor(params.rut, cuerpo.activo === true) })));

// ------------------------------------------------------------------- apps

ruta("GET", "/apps", "admin", async () => ({ apps: await listarApps() }));

ruta("POST", "/apps", "admin", async ({ cuerpo }) => comoHttp(async () => {
  const { app, llave } = await crearApp(String(cuerpo.nombre || ""), Array.isArray(cuerpo.emisores) ? cuerpo.emisores : []);
  return { ...app, llave, aviso: "Guarda esta llave ahora: no se vuelve a mostrar." };
}));

ruta("POST", "/apps/:id/llave", "admin", async ({ params }) => comoHttp(async () => ({
  llave: await renovarLlave(params.id),
  aviso: "La llave anterior dejó de servir. Guarda esta ahora: no se vuelve a mostrar.",
})));

ruta("POST", "/apps/:id/activo", "admin", async ({ params, cuerpo }) => comoHttp(async () => {
  await activarApp(params.id, cuerpo.activo === true);
  return { activo: cuerpo.activo === true };
}));

// --------------------------------------------------------------- bitácora

ruta("GET", "/bitacora", "admin", async ({ consulta: q }) => {
  const limite = Math.min(500, Math.max(1, Number(q.get("limite") || 100)));
  return {
    entradas: await consulta(
      "select app, emisor_rut, accion, detalle, ok, t from bitacora order by id desc limit $1", [limite],
    ),
  };
});

// ------------------------------------------------------------ documentos

ruta("POST", "/documentos", "app", async ({ app, cuerpo }) => comoHttp(async () => {
  if (!cuerpo.emisor) throw malaPeticion("Falta el emisor.");
  if (app && !appPuedeCon(app, cuerpo.emisor)) {
    throw prohibido(`La aplicación ${app.nombre} no tiene permitido operar con ese emisor.`);
  }
  return emitir(app!.nombre, cuerpo);
}));

ruta("GET", "/documentos", "app", async ({ consulta: q }) => ({
  documentos: await listarDocumentos({
    emisor: q.get("emisor") || undefined,
    estado: q.get("estado") || undefined,
    desde: q.get("desde") || undefined,
    limite: Number(q.get("limite") || 100),
  }),
}));

ruta("GET", "/documentos/:id", "app", async ({ params }) => {
  const d = await verDocumento(params.id);
  if (!d) throw noEncontrado(`No hay un documento con id ${params.id}.`);
  return d;
});

/** El XML firmado, que es lo que se le entrega al receptor. */
ruta("GET", "/documentos/:id/xml", "app", async ({ params, res }) => {
  const xml = await xmlDocumento(params.id);
  if (!xml) throw noEncontrado("Ese documento todavía no tiene XML.");
  const cuerpo = Buffer.from(xml, "utf8");
  res.writeHead(200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Content-Length": cuerpo.length,
    "Content-Disposition": `attachment; filename="dte-${params.id}.xml"`,
  });
  res.end(cuerpo);
});

/** Preguntarle al SII ahora mismo, sin esperar al trabajo de seguimiento. */
ruta("POST", "/documentos/:id/estado", "app", async ({ params }) => comoHttp(async () => {
  const d = await actualizarEstado(params.id);
  if (!d) throw noEncontrado(`No hay un documento con id ${params.id}.`);
  return d;
}));

/**
 * La representación impresa, con el timbre PDF417.
 *
 * Dos formatos, no uno encogido: `carta` para la hoja que se entrega o se archiva,
 * y `termica` para el rollo de 80 mm del punto de venta. Se elige con ?formato=.
 */
ruta("GET", "/documentos/:id/pdf", "app", async ({ params, consulta: q, res }) => comoHttp(async () => {
  const formato = q.get("formato") === "termica" ? "termica" : "carta";
  const datos = await datosImpresion(params.id);
  const pdf = formato === "termica" ? await pdfTermico(datos) : await pdfDocumento(datos);
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Length": pdf.length,
    "Content-Disposition": `inline; filename="dte-${params.id}-${formato}.pdf"`,
  });
  res.end(pdf);
}));

/**
 * El mismo documento, buscado como lo conoce quien lo emitió: por emisor, tipo y
 * folio. Sirve para preguntar "¿fue aceptada mi boleta 1234?" sin haber guardado
 * el identificador que devolvió este servicio.
 */
ruta("GET", "/documentos/:rut/:tipo/:folio", "app", async ({ params }) => {
  const d = await documentoPorFolio(params.rut, Number(params.tipo), Number(params.folio));
  if (!d) throw noEncontrado(`No hay un documento tipo ${params.tipo} folio ${params.folio} para ${params.rut}.`);
  return d;
});
