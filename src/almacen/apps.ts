import { consulta } from "./db";
import { nuevaLlaveApi, hashLlaveApi } from "./cifrado";
import { rutPlano } from "../sii/caf";
import { ErrorDatos, NoExiste } from "./errores";

/*
 * Las aplicaciones que consumen el servicio: Patiolo y las que vengan.
 *
 * De la llave se guarda solo el hash. Si la base se filtra, no se puede entrar con
 * lo que hay dentro, y por lo mismo la llave se muestra **una sola vez**, al crearla:
 * después ya no existe en ninguna parte.
 *
 * Una aplicación puede quedar limitada a ciertos emisores. Vacío significa todos,
 * que es lo razonable cuando el dueño del servicio es el mismo de las aplicaciones.
 */

export interface App {
  id: string;
  nombre: string;
  emisores: string[];
  activo: boolean;
  creado: number;
  ultimoUso: number | null;
}

const aApp = (f: any): App => ({
  id: String(f.id), nombre: f.nombre, emisores: f.emisores || [], activo: f.activo,
  creado: new Date(f.creado).getTime(),
  ultimoUso: f.ultimo_uso ? new Date(f.ultimo_uso).getTime() : null,
});

export async function listarApps(): Promise<App[]> {
  return (await consulta("select id, nombre, emisores, activo, creado, ultimo_uso from apps order by nombre")).map(aApp);
}

/** Crea una aplicación y devuelve su llave. Es la única vez que se puede ver. */
export async function crearApp(nombre: string, emisores: string[] = []): Promise<{ app: App; llave: string }> {
  if (!nombre.trim()) throw new ErrorDatos("Falta el nombre de la aplicación.");
  const llave = nuevaLlaveApi();
  const r = await consulta(
    `insert into apps (nombre, llave_hash, emisores) values ($1,$2,$3)
     returning id, nombre, emisores, activo, creado, ultimo_uso`,
    [nombre.trim().slice(0, 80), hashLlaveApi(llave), emisores.map(rutPlano)],
  );
  return { app: aApp(r[0]), llave };
}

/** Cambia la llave de una aplicación. La anterior deja de servir al instante. */
export async function renovarLlave(id: string): Promise<string> {
  const llave = nuevaLlaveApi();
  const r = await consulta("update apps set llave_hash = $2 where id = $1 returning id", [id, hashLlaveApi(llave)]);
  if (!r.length) throw new NoExiste("Esa aplicación no existe.");
  return llave;
}

export async function activarApp(id: string, activo: boolean): Promise<void> {
  const r = await consulta("update apps set activo = $2 where id = $1 returning id", [id, activo]);
  if (!r.length) throw new NoExiste("Esa aplicación no existe.");
}

/**
 * Reconoce una llave.
 *
 * La búsqueda es por hash, así que es un índice único y no un recorrido comparando
 * una por una: no hay nada que medir desde fuera para adivinar la llave.
 */
export async function appDeLlave(llave: string): Promise<App | null> {
  if (!llave || !llave.startsWith("dte_")) return null;
  const r = await consulta(
    "select id, nombre, emisores, activo, creado, ultimo_uso from apps where llave_hash = $1 and activo",
    [hashLlaveApi(llave)],
  );
  if (!r.length) return null;
  // El último uso se anota sin esperar: no vale la pena frenar la petición por esto.
  consulta("update apps set ultimo_uso = now() where id = $1", [r[0].id]).catch(() => { /* da igual */ });
  return aApp(r[0]);
}

/** ¿Esta aplicación puede operar con este emisor? */
export const appPuedeCon = (app: App, rut: string): boolean =>
  app.emisores.length === 0 || app.emisores.includes(rutPlano(rut));
