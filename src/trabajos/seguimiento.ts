import { consulta } from "../almacen/db";
import { actualizarEstado, Transporte } from "../emision";

/*
 * El seguimiento de los envíos.
 *
 * El SII recibe el sobre y devuelve un TRACKID al instante, pero el resultado —si
 * el documento fue aceptado, aceptado con reparos o rechazado— puede tardar
 * minutos. Nadie va a esperar con la conexión abierta, así que la pregunta la hace
 * este trabajo cada tanto.
 *
 * Solo mira los documentos que están "enviado": los demás ya tienen su respuesta.
 * Y espera un poco antes del primer intento, porque preguntar de inmediato siempre
 * devuelve "en proceso" y gasta una llamada.
 */

const CADA_MS = Number(process.env.DTE_SEGUIMIENTO_MS || 60000);
const ESPERA_MINIMA_S = 90;   // antes de esto el SII casi siempre dice "procesando"
const POR_VUELTA = 20;

let andando: NodeJS.Timeout | null = null;
let trabajando = false;

/** Una vuelta: toma los enviados que llevan rato esperando y les pregunta. */
export async function unaVuelta(trans?: Transporte): Promise<number> {
  const pendientes = await consulta<{ id: string }>(
    `select id from documentos
      where estado = 'enviado' and track_id is not null
        and actualizado < now() - interval '${ESPERA_MINIMA_S} seconds'
      order by actualizado
      limit ${POR_VUELTA}`,
  );

  let resueltos = 0;
  for (const { id } of pendientes) {
    const d = await actualizarEstado(id, trans);
    if (d && d.estado !== "enviado") resueltos++;
  }
  return resueltos;
}

export function arrancarSeguimiento(): void {
  if (andando) return;
  andando = setInterval(async () => {
    // Si una vuelta se demoró más que el intervalo, no se encima otra encima.
    if (trabajando) return;
    trabajando = true;
    try {
      const n = await unaVuelta();
      if (n) console.log(`[seguimiento] ${n} documento(s) con respuesta del SII`);
    } catch (e: any) {
      console.error("[seguimiento]", e?.message || e);
    } finally {
      trabajando = false;
    }
  }, CADA_MS);
  // Que este reloj no impida que el proceso termine cuando lo apaguen.
  andando.unref?.();
  console.log(`[seguimiento] consultando el SII cada ${Math.round(CADA_MS / 1000)}s`);
}

export function detenerSeguimiento(): void {
  if (andando) { clearInterval(andando); andando = null; }
}
