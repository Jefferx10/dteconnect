/*
 * Errores del dominio.
 *
 * La API necesita saber si algo falló por culpa de quien llamó o por culpa del
 * servicio, para responder 400 o 500. Adivinarlo leyendo el texto del mensaje es
 * frágil: basta reescribir una frase para que un error de datos empiece a salir
 * como falla interna. Por eso se distinguen por tipo.
 */

/** Los datos que llegaron no sirven. Culpa de quien llama: 400. */
export class ErrorDatos extends Error {
  constructor(mensaje: string) { super(mensaje); this.name = "ErrorDatos"; }
}

/** Lo que se pidió no existe: 404. */
export class NoExiste extends Error {
  constructor(mensaje: string) { super(mensaje); this.name = "NoExiste"; }
}

/** Se acabaron los folios. No es un error de datos: es un recurso agotado. */
export class SinFolios extends Error {
  constructor(public tipo: number) {
    super(`No quedan folios para documentos tipo ${tipo}. Carga un CAF nuevo antes de seguir emitiendo.`);
    this.name = "SinFolios";
  }
}
