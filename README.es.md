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

Requiere Node.js 24+ y Podman. Desde `hub/`:

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
