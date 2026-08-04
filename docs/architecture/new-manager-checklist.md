# Checklist para un nuevo server-manager

Antes de habilitar un juego en el hub:

- [ ] Identificador de manager/juego estable y `server-manager.contract.json` válido.
- [ ] UUID persistente por instancia; nunca derivado del nombre del contenedor.
- [ ] Manifiesto runtime atómico `0600`, sin valores secretos.
- [ ] Etiquetas OCI v1 en todos los roles obligatorios.
- [ ] Driver JSON local, sin shell, con errores/códigos estables e idempotencia.
- [ ] `flock`, revisión CAS, claim/release y exclusión con despliegues manuales.
- [ ] Podman secrets y archivos fuente `0600`; nada secreto en imagen, DB o logs.
- [ ] Health check y rollback del último reemplazo de contenedores.
- [ ] Adaptador tipado que valida topología, mounts, etiquetas y capacidades.
- [ ] Pruebas unitarias del contrato y E2E rootless: desplegar, adoptar, controlar,
      actualizar, desvincular y confirmar que no se copiaron/eliminaron datos.
- [ ] Runbook de parche, recuperación de operación abandonada y downgrade.
