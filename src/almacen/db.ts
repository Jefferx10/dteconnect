import { Pool, PoolClient } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * La conexión a Postgres y el envoltorio de transacciones.
 *
 * Todo lo que reparte folios pasa por `enTransaccion`: entregar un folio y
 * registrarlo tienen que ocurrir juntos o no ocurrir, porque un folio entregado y
 * no registrado es exactamente lo que el SII audita.
 */

let piscina: Pool | null = null;

export function pool(): Pool {
  if (piscina) return piscina;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Falta DATABASE_URL.");
  piscina = new Pool({
    connectionString: url,
    max: Number(process.env.DB_MAX_CONEXIONES || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  // Una conexión rota no debe tumbar el proceso.
  piscina.on("error", (e) => console.error("[db] conexión inactiva con error:", e.message));
  return piscina;
}

export const consulta = async <T = any>(sql: string, valores: unknown[] = []): Promise<T[]> =>
  (await pool().query(sql, valores)).rows as T[];

/** Abre una transacción, la confirma si todo sale bien y la revierte si no. */
export async function enTransaccion<T>(f: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query("begin");
    const r = await f(c);
    await c.query("commit");
    return r;
  } catch (e) {
    try { await c.query("rollback"); } catch { /* la conexión ya se cayó */ }
    throw e;
  } finally {
    c.release();
  }
}

/** Crea o actualiza el esquema. Es idempotente: se ejecuta en cada arranque. */
export async function migrar(): Promise<void> {
  const sql = readFileSync(join(__dirname, "esquema.sql"), "utf8");
  await pool().query(sql);
}

/** Espera a que la base acepte conexiones. El contenedor puede arrancar antes que ella. */
export async function esperarBase(intentos = 30, cada = 2000): Promise<void> {
  for (let i = 1; i <= intentos; i++) {
    try { await pool().query("select 1"); return; } catch (e: any) {
      if (i === intentos) throw new Error(`La base de datos no respondió tras ${intentos} intentos: ${e?.message}`);
      await new Promise((ok) => setTimeout(ok, cada));
    }
  }
}

export async function cerrar(): Promise<void> {
  if (piscina) { await piscina.end(); piscina = null; }
}

/** Deja constancia de lo que pidió cada aplicación. Nunca interrumpe la operación. */
export async function anotar(
  accion: string,
  { app, emisor, detalle, ok = true }: { app?: string; emisor?: string; detalle?: string; ok?: boolean } = {},
): Promise<void> {
  try {
    await consulta(
      "insert into bitacora (app, emisor_rut, accion, detalle, ok) values ($1,$2,$3,$4,$5)",
      [app ?? null, emisor ?? null, accion, (detalle ?? "").slice(0, 1000), ok],
    );
  } catch (e: any) {
    console.error("[bitacora]", accion, e?.message);
  }
}
