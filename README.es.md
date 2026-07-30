# Server Hub

**Idiomas:** [English](README.md) · [Español](README.es.md) · [Deutsch](README.de.md)

Panel central de alojamiento multijuego: crea, inicia/detiene y elimina
**instancias** independientes de `arma_server` y `proyect_zomboid` (y de
futuros gestores de otros juegos) en paralelo en una misma máquina, desde un
único panel.

El hub no reimplementa mods/RCON/backups/edición de sandbox — cada instancia
sigue ejecutando la pila completa y ya existente de `arma_server`/
`proyect_zomboid` (sus propios contenedores de API + frontend, su propio
estado SQLite, su propio inicio de sesión de administrador). El hub solo
aprovisiona instancias, controla su ciclo de vida y enlaza con el panel
propio de cada una.

## Proyectos relacionados

- [Arma 3 Server Manager](https://github.com/cBarredez/Arma3-server-manager) —
  el panel de instancia única de Arma 3 del que este hub aprovisiona copias.
- [Project Zomboid Server Manager](https://github.com/cBarredez/Proyect_zomboid_manager) —
  el panel de instancia única de Project Zomboid del que este hub aprovisiona
  copias.

Ambos se clonan como directorios hermanos (`arma_server/`, `proyect_zomboid/`)
junto a `hub/`; sus `Containerfile.api`/`Containerfile.frontend` se usan
directamente como contexto de compilación de Podman para cada instancia que
crea el hub.

## Funcionalidades

- Crear, listar, iniciar/detener/reiniciar y eliminar instancias de
  cualquiera de los dos juegos en paralelo, cada una totalmente aislada (red,
  volúmenes, nombres de contenedor y puertos propios).
- Límite de memoria por instancia, aplicado directamente sobre el flag
  `--memory` del contenedor.
- Solicitud de espacio en disco por instancia — se aplica cuando el backend
  de almacenamiento de Podman del host soporta cuotas de volumen; el hub
  avisa claramente cuando no puede aplicarse (la mayoría de configuraciones,
  incluidos los backends ext4/overlay habituales, no lo soportan).
- Se ejecuta una comprobación activa de disponibilidad de puertos TCP/UDP
  antes de asignar cualquier puerto, de modo que una instancia nueva no puede
  chocar con otra instancia gestionada por el hub *ni* con cualquier otra
  cosa que ya esté escuchando en el host (una copia de `arma_server`/
  `proyect_zomboid` ejecutada manualmente, otra aplicación, etc.).
- Ver las credenciales de acceso de administrador de una instancia desde su
  tarjeta en cualquier momento (se leen en vivo desde la configuración ya
  generada de esa instancia — nunca se guardan por duplicado).
- Imagen de portada del juego en cada tarjeta de instancia.
- Uso de CPU/RAM/disco en vivo por instancia (mediante `podman stats` y
  `podman system df -v`), sondeado de forma independiente a la actualización
  de estado por ser una llamada más pesada.
- Buscador en el panel para filtrar instancias por nombre.
- Un resumen global sobre la cuadrícula de instancias que suma CPU/RAM/disco
  de todas ellas, junto con un contador de en ejecución/total.
- Los límites de memoria y disco se pueden cambiar en cualquier momento
  desde la tarjeta de una instancia, no solo al crearla. La memoria se
  aplica de inmediato (`podman update` cambia en vivo el límite de un
  contenedor en ejecución, sin necesidad de reiniciar); el disco no tiene un
  equivalente en vivo en Podman, así que el nuevo valor se guarda y solo se
  aplica la próxima vez que se recree esa instancia.
- Mantenimiento desatendido: reinicio automático ante fallos, reinicios
  programados diarios opcionales, seguimiento de actualizaciones del código
  fuente con reconstrucción de imagen y recreación de instancia con un clic,
  autoactualización del propio hub, y limpieza diaria de imágenes huérfanas
  — ver [Mantenimiento](#mantenimiento) más abajo.

## Mantenimiento

Un planificador en segundo plano (`infra/scheduler.ts`, se ejecuta cada 60s)
gestiona la mayoría de los comportamientos automáticos siguientes; las
comprobaciones de actualizaciones de código fuente (tanto de las imágenes de
juego como del propio hub) son lo bastante baratas como para calcularse en
vivo bajo demanda en su lugar. Todo es configurable desde la pestaña
**Maintenance**:

- **Reinicio automático ante fallos**: si los contenedores de una instancia
  se detienen inesperadamente mientras se supone que debería estar en
  ejecución (es decir, nadie pulsó Stop), el hub la reinicia
  automáticamente, hasta un límite de intentos configurable — superado ese
  límite, deja de intentarlo y muestra la instancia visiblemente
  `degraded` en vez de reiniciarla en bucle indefinidamente. Un Start/Restart
  manual reinicia el contador. Esto es también lo que hace que las instancias
  vuelvan tras reiniciar la propia máquina host: el estado deseado de cada
  instancia vive en la base de datos SQLite del hub, no en memoria, así que
  sobrevive a que el propio proceso del hub se reinicie junto con todo lo
  demás; la comprobación de mantenimiento se ejecuta una vez de inmediato al
  arrancar (no solo con su cadencia normal de 60s), para que las instancias
  que estaban en ejecución antes de un reinicio no se queden apagadas hasta
  un minuto antes de que el hub siquiera lo note. Si Podman en sí todavía no
  está disponible (su propia máquina/servicio puede tardar en arrancar tras
  reiniciar el host), el hub se salta esa comprobación por completo en vez de
  tratar a todas las instancias como si hubieran fallado y gastar su
  presupuesto de reintentos por un motivo que no tiene nada que ver con las
  instancias en sí.
- **Reinicios programados**: hora de reinicio diario opcional por instancia
  (`HH:MM`, hora local del host), configurable desde la tarjeta de la
  instancia. Se dispara como máximo una vez al día.
- **Seguimiento de actualizaciones de imagen**: el hub marca cada instancia
  con el commit de git de `arma_server`/`proyect_zomboid` con el que se
  construyó su imagen. La pestaña Maintenance compara eso con el `HEAD`
  actual de cada repo y marca en vivo las instancias desactualizadas (sin
  necesidad de sondeo — son solo un par de llamadas a `git rev-parse`).
  "Pull latest" ejecuta `git pull --ff-only` en el repo hermano (falla de
  forma limpia en vez de fusionar/rebasar si ha divergido — por ejemplo, si
  alguien editó archivos a mano en el host), "Rebuild image" construye
  imágenes nuevas para un tipo de juego a partir de lo que haya actualmente
  descargado, y "Recreate from latest image" cambia una instancia concreta a
  esas imágenes sin tocar sus puertos, volúmenes ni configuración. Si esa
  instancia está en ejecución en ese momento, el cambio se pospone en vez de
  aplicarse de inmediato — queda marcada como "actualización en cola" y se
  aplica automáticamente la próxima vez que la instancia se detenga y vuelva
  a arrancar por cualquier motivo (Start/Restart manual, un reinicio
  programado, o una recuperación ante fallo), de modo que pulsar Recreate
  nunca interrumpe por sí mismo una sesión en curso. Pull y
  rebuild comparten un bloqueo por tipo de juego para que nunca se ejecuten
  a la vez sobre el mismo árbol de trabajo. **Limitación**: solo detecta
  cambios confirmados (committed) en los repos hermanos, no ediciones
  locales sin confirmar.
- **Autoactualización del hub**: independiente del seguimiento de imágenes
  de arriba — esto es el código fuente *propio* del hub, no el de
  `arma_server`/`proyect_zomboid`. La pestaña Maintenance muestra si el
  remoto de git del hub tiene commits que el hub en ejecución todavía no
  tiene (`git fetch` + comparación contra `HEAD`). "Update & restart hub"
  ejecuta `git pull --ff-only`, `npm install` (solo si realmente cambió
  algún `package.json`/`package-lock.json`), reconstruye tanto el backend
  como el frontend, y luego entrega el control a un proceso recién lanzado y
  termina — la página pierde brevemente la conexión durante ese traspaso y
  se reconecta sola en cuanto el nuevo proceso empieza a escuchar. Si el pull
  o el build fallan, no se toca nada: el proceso actual sigue funcionando
  exactamente igual que antes, y el fallo queda registrado en el log de
  actividad en vez de tumbar el hub.
- **Limpieza automática del host**: una purga diaria de imágenes huérfanas
  (la misma operación que ya se ejecuta tras cada compilación), para que la
  limpieza no dependa de que te acuerdes de hacerla manualmente.

Toda acción de mantenimiento —reinicios automáticos, reinicios programados,
reconstrucciones, recreaciones, limpiezas— queda registrada y visible en el
registro de actividad de la pestaña Maintenance.

## Arquitectura

| Capa | Tecnología |
|---|---|
| Backend | Node.js 24 + Fastify + TypeScript |
| Frontend | React 19 + Vite |
| Estado | SQLite (better-sqlite3) — registro de instancias + contadores de puertos |
| Configuración | TOML |
| Orquestación | CLI de Podman, invocada directamente (sin archivos compose) |

```text
backend/src/
├── config/      cargador del manager.toml/manager.secrets.toml propio del hub
├── security/    hash de contraseña con scrypt + cookie de sesión firmada con HMAC
├── infra/       podman.ts (envoltorio de execFile), portCheck.ts (disponibilidad
│                de puertos en vivo), sqliteStore.ts, portAllocator.ts
├── templates/   un módulo por cada juego soportado: puertos, nombres de
│                volumen/contenedor/red, generadores de manager.toml + secrets,
│                argumentos de podman run — arma3.ts y pz.ts
├── domain/      instanceManager.ts (create/list/start/stop/restart/delete/
│                credentials)
└── routes/      auth, templates, instances

frontend/src/
├── api/client.ts
├── public/games/       portadas de Steam (arma3.jpg, pz.jpg)
└── sections/    Login, Dashboard, InstanceCard, NewInstanceModal
```

### Cómo funciona la creación de una instancia

Para una nueva instancia del juego `G`:

1. Se asigna un puerto de host para el panel web de la instancia desde un
   grupo compartido por todos los tipos de juego, más un bloque de puertos
   específico del juego desde un grupo propio de `G` (ver `templates/arma3.ts`
   / `templates/pz.ts` para las bases/pasos exactos — ambos son funciones
   puras, con pruebas unitarias junto a cada plantilla). Cada puerto candidato
   se comprueba después en vivo en el host (`infra/portCheck.ts`) antes de
   confirmarlo, saltando hacia adelante si algo ya lo está usando.
2. Se escriben `manager.toml` + `manager.secrets.toml` (secretos generados
   con `crypto.randomBytes`, igual que `proyect_zomboid/scripts/setup.mjs`)
   en `hub/data/instances/<slug>/config/`, con el límite de memoria
   solicitado ya incorporado.
3. Se compilan los Containerfiles de `G` una sola vez por tipo de juego si
   aún no existen (`localhost/arma3-manager-api:latest`, etc. — las mismas
   etiquetas de imagen que ya compilan los propios archivos compose de
   `arma_server`/`proyect_zomboid`, así que no hace falta recompilar si ya
   los has compilado tú mismo).
4. Se crea una red de Podman y unos volúmenes propios de la instancia (con
   el slug de la instancia como sufijo; el volumen principal de datos recibe
   un intento de límite de tamaño si se solicitó un límite de disco) y se
   ejecutan los contenedores de api/frontend con exactamente los mismos
   montajes/variables de entorno que los archivos `podman-compose.yml` de
   instancia única ya existentes, solo que parametrizados por instancia y
   memoria.

Eliminar una instancia borra sus contenedores, su red y (opcionalmente) sus
volúmenes, además de su directorio de configuración generado.

## Instalación

Requiere Node.js 24+ y Podman, **además de los dos repos de gestores de
juego clonados como hermanos de `hub/`** — el hub no tiene código de juego
propio; construye cada instancia a partir de sus
`Containerfile.api`/`Containerfile.frontend`:

```bash
git clone https://github.com/cBarredez/Arma3-server-manager.git arma_server
git clone https://github.com/cBarredez/Proyect_zomboid_manager.git proyect_zomboid
git clone https://github.com/cBarredez/game_servers_manager_hub.git hub
```

Los tres deben quedar uno junto a otro (`arma_server/`, `proyect_zomboid/`,
`hub/` bajo el mismo directorio padre) — esa disposición es justo lo que
resuelve `podman.repos_dir` en `hub/config/manager.toml` (por defecto
`..`). Crear una instancia de Arma3 o PZ antes de clonar el repo
correspondiente fallará en el paso de compilación de la imagen.

Después, desde `hub/`:

```bash
npm install
npm run setup            # genera config/manager.secrets.toml e imprime la contraseña de admin una vez
```

Desarrollo (dos terminales):

```bash
npm run dev:backend      # Fastify con recarga, http://127.0.0.1:4000
npm run dev:frontend     # servidor de desarrollo de Vite, http://127.0.0.1:5173, redirige /api al backend
```

Ejecución local tipo producción:

```bash
npm run build:backend
npm run build:frontend
npm start                # sirve el backend compilado en el web.port de config/manager.toml
```

El propio hub se ejecuta como un simple proceso Node en el host, **no**
dentro de un contenedor — necesita acceso directo al binario `podman` del
host y a los directorios hermanos `arma_server`/`proyect_zomboid` como
contexto de compilación, lo que de otro modo requeriría montar el socket de
Podman dentro de Podman sin ningún beneficio real a esta escala.

No hay ningún gestor de procesos vigilándolo (sin unidad de systemd, sin
pm2), así que detenerlo es lo mismo que detener cualquier proceso en
primer plano:

- Si se ejecuta en una terminal (`npm start`, `npm run dev:backend`):
  `Ctrl+C` en esa terminal.
- Si se ejecuta en segundo plano / sin terminal asociada: hay que
  encontrar y detener lo que tenga abierto `web.port` (por defecto 4000) —
  ```powershell
  # Windows PowerShell
  Get-NetTCPConnection -LocalPort 4000 -State Listen |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```
  ```bash
  # Linux/macOS
  fuser -k 4000/tcp
  ```
  Las instancias que gestiona el hub siguen ejecutándose de todos modos —
  detener el hub solo detiene el panel y su propio mantenimiento automático
  (reinicio ante fallos, reinicios programados, limpieza), no los propios
  servidores de juego.

### Configuración

- `config/manager.toml`: puerto/bind/usuario web propios del hub, más
  `podman.repos_dir` (dónde encontrar `arma_server`/`proyect_zomboid` en
  relación a `hub/`, por defecto `..`) y `ports.web_base` (primer puerto de
  host asignado al panel de cualquier instancia).
- `config/manager.secrets.toml`: contraseña de administrador y secreto de
  sesión propios del hub, generados por `npm run setup`.

Pruebas (funciones puras — cálculo de asignación de puertos, comprobaciones
de disponibilidad de puertos en vivo y generadores de config/secrets — se
ejecutan en su mayoría sin necesitar una instancia real de Podman):

```bash
npm test
```

## Limitaciones conocidas

- **Sin hosts remotos.** Las instancias solo se ejecutan en la máquina donde
  corre el propio hub, a través del socket local de Podman.
- **Los límites de espacio en disco son de mejor esfuerzo.** Solo se aplican
  en backends de almacenamiento de Podman con soporte de cuotas por proyecto
  (por ejemplo XFS); en el resto, el hub crea el volumen igualmente, solo
  que sin el límite, y te lo indica.
- **Los puertos de consulta Steam de Project Zomboid (8766/8767 UDP)** están
  fijos dentro del propio binario del servidor de PZ y no se exponen a través
  del `manager.toml` ni de los argumentos de arranque de `proyect_zomboid`.
  El hub igualmente asigna a cada instancia de PZ sus propios puertos
  distintos del lado del host para ellos (el remapeo de red en modo bridge
  se encarga de eso), así que se pueden ejecutar varias instancias de PZ a
  la vez sin conflicto de puertos — el único efecto es que el listado
  público del buscador de servidores de Steam puede no resolver
  correctamente el puerto de consulta para instancias más allá de la
  primera; las conexiones directas por IP:puerto no se ven afectadas.
- **No hay lista de puertos liberados.** Eliminar una instancia no permite
  que una instancia posterior reutilice sus puertos — los grupos solo
  cuentan hacia arriba. Es adecuado para uso informal/autoalojado; habría
  que revisarlo para instalaciones muy longevas.
- **Un único inicio de sesión de administrador**, sin permisos por instancia
  en la propia interfaz del hub (cada instancia conserva su propio inicio de
  sesión de administrador independiente, ajeno al del hub).
