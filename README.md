# DTEConnect

Servicio de facturación electrónica. Arma, firma y envía documentos tributarios al
SII, y expone una API propia para que la usen Patiolo y las demás aplicaciones.

El SII certifica **por contribuyente**, no por software: cada emisor pasa su propio
proceso antes de emitir en producción. Hasta entonces, todo va contra `maullin`.

## Puesta en marcha

```bash
cp .env.ejemplo .env
openssl rand -base64 48        # pegar el resultado en DTE_LLAVE_MAESTRA
docker compose up -d --build
```

**Respalda la llave maestra fuera del servidor.** Con ella se cifran los
certificados y los CAF guardados; si se pierde, no hay forma de recuperarlos y hay
que volver a cargarlos todos.

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
2. **Un folio entregado no vuelve al rango.** Si el documento falla, el folio queda
   anulado y hay que informarlo. Reutilizarlo es peor.

## Ambientes

| | Certificación | Producción |
|---|---|---|
| Base | `maullin.sii.cl` | `palena.sii.cl` |
| Folios | CAF de prueba | CAF reales |
| Resolución | número 0 | la del contribuyente |

El mismo código sirve para los dos: cambia la base de la URL y los folios.
