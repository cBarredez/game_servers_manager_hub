# ADR-002: despliegue externo del hub

- Estado: aceptado
- Fecha: 2026-08-04

## Contexto

No existe un registry privado para distribuir imágenes del hub. Además, una
autoactualización iniciada desde el propio proceso no puede restaurar con
fiabilidad su SQLite, su unidad de arranque o la imagen anterior cuando el
proceso deja de estar sano.

## Decisión

El hub se construye en el servidor desde una release transferida por SSH y se
ejecuta como un único contenedor Podman rootless administrado por Quadlet y
systemd de usuario. `deploy.py`, ejecutado fuera del hub, es la única autoridad
para bootstrap, actualización, backup y rollback.

El contenedor usa el socket Podman del mismo usuario Unix y monta en las mismas
rutas absolutas los datos, el registro v1, la instalación de ARMA y los
repositorios legacy. El secreto de acceso es un Podman secret persistente que
no forma parte de la imagen ni de la release.

## Consecuencias

- No se requiere publicar imágenes propias.
- Una actualización puede revertirse aunque el contenedor nuevo no arranque.
- El hub deja de ejecutar `git pull`, instalar dependencias o reemplazar su
  propio proceso; la API anterior responde un conflicto explícito.
- Montar el socket concede al hub control completo sobre los recursos Podman
  del usuario y eleva la sensibilidad de la imagen y del acceso administrativo.
- Los managers continúan teniendo ciclos de despliegue independientes.

