# DTEConnect

Servicio de facturación electrónica. Arma, firma y envía documentos tributarios al
SII, y expone una API propia para que la usen Patiolo y las demás aplicaciones.

El SII certifica **por contribuyente**, no por software: cada emisor pasa su propio
proceso antes de emitir en producción. Hasta entonces, todo va contra `maullin`.

## Puesta en marcha

Antes de nada, el dominio tiene que apuntar a la IP del servidor: Caddy saca el
certificado TLS solo, y si el nombre no resuelve, no lo emite.

```bash
cp ejemplo.env.txt .env

openssl rand -base64 48        # → DTE_LLAVE_MAESTRA
openssl rand -base64 36        # → DTE_LLAVE_ADMIN
openssl rand -hex 24           # → POSTGRES_PASSWORD, y la misma en DATABASE_URL

# completar también DOMINIO y CORREO_TLS
docker compose up -d --build
curl https://TU_DOMINIO/salud
```

Solo el proxy abre puertos al mundo. La API y la base no se publican: se alcanzan
por la red interna del compose.

**Respalda la llave maestra fuera del servidor.** Con ella se cifran los
certificados y los CAF guardados; si se pierde, no hay forma de recuperarlos y hay
que volver a cargarlos todos. Guárdala en otro lugar que los respaldos de la base:
juntos vuelven a ser una sola cosa que robar.

Después, `despliegue/respaldo.sh` en el cron. Lo que respalda no es solo historia:
son los contadores de folios.

## Las tres llaves

| | Para qué | Quién la tiene |
|---|---|---|
| `DTE_LLAVE_MAESTRA` | Cifra certificados y CAF en la base | Solo el servidor, y un respaldo aparte |
| `DTE_LLAVE_ADMIN` | Dar de alta emisores, cargar certificados y CAF | Solo tú |
| Llave de aplicación | Emitir y consultar | Patiolo y cada programa, una distinta |

La llave de una aplicación se muestra **una sola vez**, al crearla. No se guarda en
claro: en la base queda solo su hash.

## Qué hay adentro

```
src/sii/          el núcleo: nada de esto depende del servidor ni de la base
  caf.ts          lee el CAF y conserva el bloque <CAF> literal
  ted.ts          el timbre, firmado con la clave del CAF
  cert.ts         abre el .pfx y saca lo que necesita la firma
  firma.ts        XML-DSig como lo pide el SII (C14N exclusiva, SHA1, RSA-SHA1)
  documento.ts    el <Documento> de factura y boleta, con sus totales
  envio.ts        el <EnvioDTE>, la carátula y la conversión a ISO-8859-1
  transporte.ts   semilla, token, subida y consulta de estado
src/almacen/
  cifrado.ts      AES-256-GCM en reposo y llaves de API
```

## Dos reglas que no se pueden romper

1. **Se firman exactamente los bytes que se envían.** El `<DD>` del timbre y el
   bloque `<CAF>` se arman una vez como texto y se incrustan tal cual. Pasarlos por
   un DOM cambia algún byte y la firma deja de validar.
2. **Un folio entregado no vuelve al rango.** Si el envío al SII falla, el folio
   queda **asignado** —no anulado— con el DTE ya firmado guardado, para reenviarlo.
   Anularlo dejaría un hueco en la numeración que el SII después pregunta, y
   reutilizarlo es peor todavía.

## Ambientes

| | Certificación | Producción |
|---|---|---|
| Base | `maullin.sii.cl` | `palena.sii.cl` |
| Folios | CAF de prueba | CAF reales |
| Resolución | número 0 | la del contribuyente |

El mismo código sirve para los dos: cambia la base de la URL y los folios.
