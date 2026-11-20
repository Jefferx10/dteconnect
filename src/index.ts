import { createServer } from "node:http";
import { atender } from "./api/http";
import { esperarBase, migrar, cerrar } from "./almacen/db";
import { llaveMaestra } from "./almacen/cifrado";
import { arrancarSeguimiento, detenerSeguimiento } from "./trabajos/seguimiento";
import "./api/rutas";

/*
 * DTEConnect. Arranca comprobando lo que no puede faltar: la llave maestra y la base
 * de datos. Es mejor no levantar que levantar a medias y descubrirlo al emitir.
 */

async function arrancar(): Promise<void> {
  // Si falta la llave maestra, los certificados guardados son ilegibles. Mejor
  // enterarse ahora que en la primera emisión.
  llaveMaestra();

  await esperarBase();
  await migrar();

  if ((process.env.DTE_LLAVE_ADMIN || "").length < 24) {
    console.warn("[aviso] DTE_LLAVE_ADMIN no está configurada o es corta: las rutas de administración quedan cerradas.");
  }

  const puerto = Number(process.env.PUERTO || 3000);
  const servidor = createServer((req, res) => { void atender(req, res); });
  servidor.headersTimeout = 20000;
  servidor.requestTimeout = 120000;

  servidor.listen(puerto, () => console.log(`DTEConnect escuchando en el puerto ${puerto}`));
  arrancarSeguimiento();

  // Que un despliegue no corte una emisión a medio camino.
  const apagar = async (senal: string) => {
    console.log(`[${senal}] cerrando…`);
    detenerSeguimiento();
    servidor.close();
    await cerrar().catch(() => { /* ya estaba cerrada */ });
    process.exit(0);
  };
  process.on("SIGTERM", () => void apagar("SIGTERM"));
  process.on("SIGINT", () => void apagar("SIGINT"));
}

arrancar().catch((e) => {
  console.error("No se pudo arrancar:", e?.message || e);
  process.exit(1);
});
