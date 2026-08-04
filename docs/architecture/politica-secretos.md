# Política de secretos v1

## Autoridad y almacenamiento

El server-manager, no el hub, es la autoridad de los secretos de una instancia
v1. El driver genera credenciales nuevas con un CSPRNG y crea el archivo fuente
con apertura exclusiva (`O_EXCL`/`wx`) y modo `0600`. El archivo debe ser
regular, no un enlace simbólico, y permanecer fuera de Git, imágenes y
directorios servidos por HTTP.

El secreto se registra y monta mediante Podman secrets. El manifiesto solo
incluye `{id, provider, reference}`; nunca incluye contenido, hashes de
contraseñas reutilizables, tokens, claves privadas ni credenciales. La misma
prohibición aplica a etiquetas OCI, SQLite, logs, diagnósticos y telemetría.

## Entrega y rotación

Una contraseña inicial o rotada se devuelve exactamente en la respuesta que
la crea, con `Cache-Control: no-store`, y después se descarta en el hub. No hay
endpoint de recuperación para v1. La interfaz solo ofrece rotación cuando el
contrato y el manifiesto anuncian `rotate-secrets`; de lo contrario indica que
las credenciales pertenecen al manager.

La rotación debe ser transaccional desde la perspectiva del servicio: crear el
nuevo material privado, instalar la nueva revisión de Podman secret, recrear
solo los contenedores que lo consumen, comprobar salud y restaurar la revisión
anterior si falla. No se considera completa con un simple reinicio si el
runtime no vuelve a montar secrets en reinicios.

## Compatibilidad legacy

Los registros legacy conservan temporalmente el comportamiento histórico de
credenciales. Ese permiso no se hereda al adaptar un juego a v1. ARMA adoptado
mantiene su secreto existente y no anuncia rotación en esta primera revisión;
Project Zomboid continúa legacy hasta implementar su propio driver.
