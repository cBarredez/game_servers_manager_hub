# Runbook: parche y adopción de ARMA 3

1. Respaldar `hub/data/hub.sqlite3` si ya existe el hub.
2. Actualizar el repositorio ARMA y validar secretos `chmod 600`.
3. Durante mantenimiento ejecutar un despliegue conjunto de backend+frontend.
   El parche conserva los cuatro volúmenes y el Podman secret, genera UUID,
   recrea los contenedores etiquetados, valida salud y publica `instance.json`.
4. Actualizar/construir el hub. Abrir Instances: el candidato debe aparecer
   `ready`, con ambos roles y sin advertencias.
5. Pulsar **Adopt in place**. Confirmar que no aparecen volúmenes/contenedores
   adicionales y que Start/Stop/Restart actúan sobre `arma3-api` y
   `arma3-frontend` originales.
6. Verificar que un `deploy.py` manual es rechazado mientras el claim exista.
7. Para volver a operación manual, pulsar **Detach from hub**; esto no detiene
   ni borra recursos. Repetir el despliegue normal para verificar control.

Si un despliegue manual se interrumpió y dejó `operation.json`, confirmar en el
host que ya no existe ningún proceso de despliegue, leer el `operationId`
privado y ejecutar la recuperación explícita con el driver de esa release:

```bash
python3 manager_driver.py recover-deploy \
  --instance-id <uuid> --operation-id <operation-id>
```

El driver valida el identificador bajo el lock; no se debe borrar el archivo a
mano. Si se revierte el hub, desvincular primero y restaurar el respaldo SQLite
anterior.
