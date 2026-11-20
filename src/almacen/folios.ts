import { PoolClient } from "pg";
import { consulta, enTransaccion } from "./db";
import { descifrar } from "./cifrado";
import { Caf, leerCaf } from "../sii/caf";
import { ErrorDatos, SinFolios } from "./errores";

export { SinFolios };

/*
 * Foliación controlada.
 *
 * El SII exige que la entrega de folios sea correlativa, sin saltos ni repetidos, y
 * que se pueda decir qué pasó con cada uno. De ahí las tres reglas de este módulo:
 *
 *  1. El folio se entrega dentro de una transacción, con el rango bloqueado. Dos
 *     peticiones simultáneas se ponen en fila; nunca se llevan el mismo número.
 *  2. Queda registrado **antes** de usarse, no después. Si el proceso se cae a mitad
 *     de camino, el folio aparece como asignado y se puede investigar.
 *  3. Un folio entregado no vuelve al rango. Si el documento falla, queda anulado y
 *     hay que informarlo; reutilizarlo sería peor que perderlo.
 */

export type EstadoFolio = "asignado" | "emitido" | "anulado";

/**
 * Entrega el siguiente folio disponible.
 *
 * `for update` sobre el rango elegido es lo que serializa la entrega: mientras una
 * transacción tiene ese CAF tomado, las demás esperan. Sin eso, dos emisiones
 * simultáneas leerían el mismo `ultimo` y saldrían con el mismo folio.
 */
export async function tomarFolio(
  c: PoolClient, emisorRut: string, tipo: number, motivo: string,
): Promise<{ folio: number; cafId: string }> {
  const { rows } = await c.query(
    `select id, desde, hasta, ultimo
       from cafs
      where emisor_rut = $1 and tipo = $2 and activo and ultimo < hasta
      order by desde
      limit 1
      for update`,
    [emisorRut, tipo],
  );
  if (!rows.length) throw new SinFolios(tipo);

  const caf = rows[0];
  const folio = Math.max(Number(caf.ultimo) + 1, Number(caf.desde));

  await c.query("update cafs set ultimo = $1 where id = $2", [folio, caf.id]);
  await c.query(
    `insert into folios (emisor_rut, tipo, folio, caf_id, motivo)
     values ($1, $2, $3, $4, $5)`,
    [emisorRut, tipo, folio, caf.id, motivo.slice(0, 200)],
  );

  return { folio, cafId: String(caf.id) };
}

/** Deja constancia de qué pasó con un folio ya entregado. */
export async function marcarFolio(
  emisorRut: string, tipo: number, folio: number, estado: EstadoFolio, detalle = "",
): Promise<void> {
  await consulta(
    `update folios set estado = $4, detalle = $5, actualizado = now()
      where emisor_rut = $1 and tipo = $2 and folio = $3`,
    [emisorRut, tipo, folio, estado, detalle.slice(0, 1000)],
  );
}

/** El CAF que cubre ese folio, descifrado y listo para timbrar. */
export async function cafDeFolio(emisorRut: string, tipo: number, folio: number): Promise<Caf> {
  const r = await consulta<{ xml: Buffer }>(
    `select c.xml
       from folios f join cafs c on c.id = f.caf_id
      where f.emisor_rut = $1 and f.tipo = $2 and f.folio = $3`,
    [emisorRut, tipo, folio],
  );
  if (!r.length) throw new ErrorDatos(`El folio ${folio} no está asignado para este emisor.`);
  return leerCaf(descifrar(r[0].xml).toString("utf8"));
}

export interface Disponibles {
  tipo: number;
  quedan: number;
  /** El folio más alto autorizado, para saber hasta dónde alcanza. */
  hasta: number;
  rangos: number;
}

/** Cuántos folios quedan por tipo. Sirve para avisar antes de que se acaben. */
export async function foliosDisponibles(emisorRut: string): Promise<Disponibles[]> {
  return consulta<Disponibles>(
    `select tipo,
            sum(hasta - greatest(ultimo, desde - 1))::int as quedan,
            max(hasta)::int                               as hasta,
            count(*)::int                                 as rangos
       from cafs
      where emisor_rut = $1 and activo
      group by tipo
      order by tipo`,
    [emisorRut],
  );
}

/**
 * Registra un CAF nuevo.
 *
 * El solape lo rechaza la propia base con una restricción de exclusión, así que acá
 * solo se traduce ese error a algo que se entienda. Dejarlo en la base importa: así
 * tampoco lo rompe una carga hecha por otra vía.
 */
export async function guardarCaf(
  emisorRut: string, caf: Caf, xmlCifrado: Buffer,
): Promise<{ id: string; tipo: number; desde: number; hasta: number; folios: number }> {
  try {
    const r = await consulta<{ id: string }>(
      `insert into cafs (emisor_rut, tipo, desde, hasta, ultimo, xml)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [emisorRut, caf.tipo, caf.desde, caf.hasta, caf.desde - 1, xmlCifrado],
    );
    return { id: r[0].id, tipo: caf.tipo, desde: caf.desde, hasta: caf.hasta, folios: caf.hasta - caf.desde + 1 };
  } catch (e: any) {
    if (String(e?.constraint) === "cafs_sin_solape") {
      const previos = await consulta<{ desde: number; hasta: number }>(
        `select desde, hasta from cafs
          where emisor_rut = $1 and tipo = $2 and int4range(desde, hasta, '[]') && int4range($3, $4, '[]')`,
        [emisorRut, caf.tipo, caf.desde, caf.hasta],
      );
      const choca = previos.map((p) => `${p.desde}–${p.hasta}`).join(", ");
      throw new ErrorDatos(
        `Ese CAF (${caf.desde}–${caf.hasta}) se pisa con un rango ya cargado${choca ? ` (${choca})` : ""}. ` +
        "Pide folios nuevos al SII para este sistema: dos rangos solapados terminan en folios repetidos.",
      );
    }
    throw e;
  }
}

/**
 * Toma un folio y lo usa, todo dentro de la misma transacción.
 *
 * Si `trabajo` falla, la transacción se revierte y el folio **no** se consume: es el
 * único caso en que puede volver al rango, porque nunca llegó a existir fuera de la
 * base. Una vez que el documento sale hacia el SII ya no se puede deshacer, y por eso
 * el envío ocurre fuera de esta función.
 */
export async function conFolio<T>(
  emisorRut: string, tipo: number, motivo: string,
  trabajo: (folio: number, cafId: string, c: PoolClient) => Promise<T>,
): Promise<T> {
  return enTransaccion(async (c) => {
    const { folio, cafId } = await tomarFolio(c, emisorRut, tipo, motivo);
    return trabajo(folio, cafId, c);
  });
}
