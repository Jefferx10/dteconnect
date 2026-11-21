#!/bin/sh
# Respaldo de la base de DTEConnect.
#
# Lo que se respalda acá no es solo historia: son los contadores de folios. Si un
# día hay que restaurar, el riesgo no es perder documentos, es volver a repartir
# folios que el SII ya recibió. Por eso conviene que corra seguido y que, antes de
# restaurar nada, se compare el último folio de la copia con lo que el SII tenga.
#
# La llave maestra NO está acá: sin ella los certificados de este volcado son
# ilegibles. Guárdala en otro lado, y no en el mismo lugar que estos archivos —
# juntos vuelven a ser una sola cosa que robar.
#
# Instalar con:
#   crontab -e
#   17 3 * * *  /opt/dteconnect/despliegue/respaldo.sh >> /var/log/dte-respaldo.log 2>&1

set -eu

DIR="${DIR_RESPALDO:-/var/respaldos/dteconnect}"
DIAS="${DIAS_RESPALDO:-30}"
PROYECTO="${PROYECTO:-dteconnect}"

mkdir -p "$DIR"
archivo="$DIR/dte-$(date +%Y%m%d-%H%M%S).sql.gz"

# --clean --if-exists para que el volcado se pueda restaurar sobre una base viva.
docker compose -p "$PROYECTO" exec -T db \
	pg_dump -U dte --clean --if-exists dte | gzip -9 > "$archivo.parcial"

# Recién cuando terminó bien se le pone el nombre definitivo: así un respaldo
# cortado a la mitad no queda pareciendo uno bueno.
mv "$archivo.parcial" "$archivo"
chmod 600 "$archivo"

# Que el archivo tenga contenido de verdad y no sea un gzip vacío de 20 bytes.
if [ "$(stat -c %s "$archivo")" -lt 1000 ]; then
	echo "$(date -Is)  FALLA: el respaldo salió vacío ($archivo)"
	exit 1
fi

find "$DIR" -name 'dte-*.sql.gz' -mtime "+$DIAS" -delete
find "$DIR" -name '*.parcial' -mtime +1 -delete

echo "$(date -Is)  ok  $archivo  $(du -h "$archivo" | cut -f1)"
