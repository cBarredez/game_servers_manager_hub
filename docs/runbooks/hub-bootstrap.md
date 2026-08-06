# Bootstrap y despliegue externo del hub

Este documento es la autoridad operativa para instalar, actualizar, revertir
y recuperar el hub. El proceso del hub no se actualiza a sí mismo: el
`deploy.py` de este repositorio es la única autoridad de despliegue.

## Modelo de despliegue

`deploy.py` transfiere una copia limpia del código por SSH, construye en el
servidor una imagen local `localhost/game-servers-hub:<release>` y mantiene un
único contenedor Podman rootless mediante el Quadlet de usuario
`~/.config/containers/systemd/game-servers-hub.container`.

No se necesita un registro de imágenes propio. Cada server-manager se instala
por separado con su propio despliegue; el bootstrap del hub no copia ni
actualiza managers.

El contenedor monta el socket rootless del mismo usuario. Esto le concede
control completo sobre todos los contenedores, imágenes, redes, volúmenes y
secretos visibles para ese usuario. El acceso al host y a la cuenta Unix debe
considerarse acceso administrativo al parque de servidores.

## Prerrequisitos remotos

- Linux, cgroup v2, Podman rootless, systemd de usuario y Quadlet.
- Node no es necesario en el host: la compilación ocurre dentro de la imagen.
- `podman.socket` activo y lingering habilitado para el usuario:

```bash
systemctl --user enable --now podman.socket
loginctl enable-linger games
```

- Los directorios `arma_server` y `proyect_zomboid` deben existir bajo el
  `repos_root` configurado. El registro
  `~/.local/share/game-server-managers` y la instalación de ARMA en
  `~/.local/share/arma3-manager` también son prerrequisitos independientes.
- Las imágenes base públicas deben poder descargarse o estar precargadas.

## Configuración local

Copiar `deploy.example.toml` como `deploy.toml`; este último está ignorado por
Git. Solo `server`, `username`, `host_bind_ip`, `host_port` y `repos_root` son
configurables. Las rutas de datos, releases, backups, operación y Quadlet se
derivan del home del usuario remoto.

```bash
cp deploy.example.toml deploy.toml
python3 deploy.py dev --check
python3 deploy.py dev
python3 deploy.py prod --yes
```

Producción solicita escribir `DEPLOY`, excepto cuando una automatización
explícita usa `--yes`. El puerto se publica en `127.0.0.1:4000` por defecto;
solo debe abrirse a otra interfaz detrás de un proxy o red confiable.

## Secretos

En el primer bootstrap, `deploy.py` genera con CSPRNG la contraseña y el
secreto de sesión, y envía el TOML directamente por stdin a `podman secret
create`. La contraseña se muestra una sola vez en la consola local. El secreto
no entra en argumentos, releases, logs, SQLite ni manifiestos de despliegue.

Las actualizaciones y los rollbacks conservan el secret existente y se niegan
a sustituirlo implícitamente. Para migrar un hub ejecutado en el host, definir
`legacy_hub_root` en el entorno correspondiente. Su
`config/manager.secrets.toml` debe ser un archivo regular, no un enlace
simbólico, y tener permisos `0600`.

## Actualización, estado y logs

```bash
python3 deploy.py prod --status
python3 deploy.py prod --logs
python3 deploy.py prod --yes
```

Antes de detener la unidad actual, el script construye la imagen y valida el
Quadlet candidato con el generador remoto. Después detiene el hub para copiar
SQLite de forma consistente, instala la unidad y exige que `/api/health`
devuelva el commit recién desplegado. Ante un fallo restaura datos,
configuración y Quadlet anteriores y verifica la salud de la versión previa.

Se conservan como mínimo la imagen actual y la anterior. La limpieza solo
considera imágenes con el label `project=game-servers-hub`.

## Rollback

```bash
python3 deploy.py prod --rollback
python3 deploy.py prod --rollback 20260804123000-123456
```

Sin argumento se selecciona la release anterior registrada. Con argumento se
exige una release que todavía tenga un backup compatible. Si la imagen ya no
existe pero la release sí, se reconstruye localmente antes de detener el hub.
El rollback crea además un backup de rescate para poder restaurar la versión
que estaba activa si la reversión falla.

## Migración desde una instalación host

1. Detener el proceso Node anterior y confirmar que el puerto del hub está
   libre.
2. Definir `legacy_hub_root` y ejecutar `--check`.
3. Ejecutar el primer despliegue. SQLite y credenciales solo se migran si el
   destino nuevo está vacío.
4. Validar login, discovery/adopción de ARMA, lifecycle y creación legacy de
   PZ.
5. Reiniciar el servidor y comprobar que el Quadlet inicia el hub.
6. Probar una actualización y un rollback antes de producción.

## Operaciones abandonadas

El despliegue crea atómicamente un `operation.json` privado y rechaza una
segunda operación. No se debe borrar ese archivo manualmente. Tras confirmar
que el proceso original terminó, usar exactamente el identificador informado:

```bash
python3 deploy.py prod --recover-operation 0123456789abcdef0123456789abcdef
```

La recuperación valida el identificador y rechaza la acción si detecta otra
sesión SSH no interactiva, para no romper el bloqueo de un despliegue vivo.

## Checklist posterior

- `/api/health` informa `status`, `commit`, `buildDate` y
  `deploymentMode: external`.
- El login funciona y la contraseña no aparece en logs ni archivos de
  release.
- Discovery, adopción, start/stop/restart y detach de ARMA funcionan.
- La creación y gestión legacy de PZ siguen funcionando.
- `systemctl --user status game-servers-hub.service` vuelve a estado activo
  después de reiniciar el host.

