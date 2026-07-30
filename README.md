# Server Hub

**Languages:** [English](README.md) · [Español](README.es.md) · [Deutsch](README.de.md)

Multi-game server hosting hub: create, start/stop, and delete independent
**instances** of `arma_server` and `proyect_zomboid` (and future game managers)
side by side on one machine, from a single panel.

The hub does not reimplement mods/RCON/backups/sandbox editing — each
instance still runs the existing, full-featured `arma_server`/`proyect_zomboid`
stack (its own API + frontend containers, own SQLite state, own admin login).
The hub only provisions instances, tracks their lifecycle, and links to each
one's own panel.

## Related projects

- [Arma 3 Server Manager](https://github.com/cBarredez/Arma3-server-manager) —
  the single-instance Arma 3 panel this hub provisions copies of.
- [Project Zomboid Server Manager](https://github.com/cBarredez/Proyect_zomboid_manager) —
  the single-instance Project Zomboid panel this hub provisions copies of.

Both are cloned as sibling directories (`arma_server/`, `proyect_zomboid/`) next
to `hub/`; their `Containerfile.api`/`Containerfile.frontend` are used directly
as the Podman build context for every instance the hub creates.

## Features

- Create, list, start/stop/restart, and delete instances of either game side
  by side, each fully isolated (own network, volumes, container names, ports).
- Per-instance memory limit, enforced on the container's own `--memory` flag.
- Per-instance disk-space request — enforced when the host's Podman storage
  backend supports volume quotas; the hub tells you plainly when it can't be
  (most setups, including plain ext4/overlay backends, don't support this).
- An active TCP/UDP port-availability check runs before any port is handed
  out, so a new instance can't collide with another hub-managed instance *or*
  with anything else already listening on the host (a manually-run copy of
  `arma_server`/`proyect_zomboid`, another app, etc.).
- View an instance's admin login credentials from its card at any time (read
  live from that instance's own generated config — never stored a second time).
- Game cover art per instance card.

## Architecture

| Layer | Technology |
|---|---|
| Backend | Node.js 24 + Fastify + TypeScript |
| Frontend | React 19 + Vite |
| State | SQLite (better-sqlite3) — instance registry + port-pool counters |
| Configuration | TOML |
| Orchestration | Podman CLI, invoked directly (no compose files) |

```text
backend/src/
├── config/      hub's own manager.toml/manager.secrets.toml loader
├── security/    scrypt password hashing + HMAC-signed session cookie
├── infra/       podman.ts (execFile wrapper), portCheck.ts (live port
│                availability), sqliteStore.ts, portAllocator.ts
├── templates/   one module per supported game: ports, volume/container/
│                network names, manager.toml + secrets renderers, podman
│                run args — arma3.ts and pz.ts
├── domain/      instanceManager.ts (create/list/start/stop/restart/delete/
│                credentials)
└── routes/      auth, templates, instances

frontend/src/
├── api/client.ts
├── public/games/       Steam header art (arma3.jpg, pz.jpg)
└── sections/    Login, Dashboard, InstanceCard, NewInstanceModal
```

### How instance creation works

For a new instance of game `G`:

1. Allocate a host port for the instance's web panel from a pool shared
   across every game type, plus a game-specific port block from a pool
   scoped to `G` (see `templates/arma3.ts` / `templates/pz.ts` for exact
   bases/steps — both are pure functions, unit-tested next to each
   template). Every candidate port is then checked live on the host
   (`infra/portCheck.ts`) before it's committed to, skipping forward past
   anything already in use.
2. Write `manager.toml` + `manager.secrets.toml` (secrets generated with
   `crypto.randomBytes`, same approach as `proyect_zomboid/scripts/setup.mjs`)
   into `hub/data/instances/<slug>/config/`, with the requested memory limit
   baked in.
3. Build `G`'s Containerfiles once per game type if not already built
   (`localhost/arma3-manager-api:latest`, etc. — identical image tags to what
   `arma_server`/`proyect_zomboid`'s own compose files already build, so no
   rebuild is needed if you've already built them yourself).
4. Create a per-instance Podman network + volumes (suffixed with the
   instance's slug; the main data volume gets a size option attempt if a
   disk limit was requested) and run the api/frontend containers with the
   exact same mounts/env vars as the existing single-instance
   `podman-compose.yml` files, just parameterized by instance and memory.

Deleting an instance removes its containers, network, and (optionally)
volumes, plus its generated config directory.

## Setup

Requires Node.js 24+ and Podman. From `hub/`:

```bash
npm install
npm run setup            # generates config/manager.secrets.toml + prints the admin password once
```

Development (two terminals):

```bash
npm run dev:backend      # Fastify with reload, http://127.0.0.1:4000
npm run dev:frontend     # Vite dev server, http://127.0.0.1:5173, proxies /api to the backend
```

Production-ish local run:

```bash
npm run build:backend
npm run build:frontend
npm start                # serves the built backend on config/manager.toml's web.port
```

The hub itself runs as a plain Node process on the host, **not** inside a
container — it needs direct access to the host's `podman` binary and to the
sibling `arma_server`/`proyect_zomboid` directories as build contexts, which
would otherwise require Podman-in-Podman socket mounting for no real benefit
at this scale.

### Configuration

- `config/manager.toml`: hub's own web port/bind/username, plus
  `podman.repos_dir` (where to find `arma_server`/`proyect_zomboid` relative
  to `hub/`, default `..`) and `ports.web_base` (first host port handed out
  to any instance's panel).
- `config/manager.secrets.toml`: hub's own admin password + session secret,
  generated by `npm run setup`.

Tests (pure functions — port allocation math, live port-availability checks,
and config/secrets renderers — run without needing a real Podman instance
for most of them):

```bash
npm test
```

## Known limitations

- **No remote hosts.** Instances only run on the machine the hub itself runs
  on, via the local Podman socket.
- **Disk-space limits are best-effort.** Only enforced on Podman storage
  backends with project-quota support (e.g. XFS); on everything else the
  hub still creates the volume, just without the cap, and says so.
- **Project Zomboid's Steam query ports (8766/8767 UDP)** are fixed inside
  the PZ server binary and not exposed through `proyect_zomboid`'s
  `manager.toml`/startup args. The hub still gives each PZ instance its own
  distinct *host*-side ports for them (bridge-network remapping handles
  that), so multiple PZ instances can run at once without a port conflict —
  the only effect is that Steam's public server-browser listing may not
  resolve the query port correctly for instances beyond the first; direct
  IP:port joins are unaffected.
- **No free-list for ports.** Deleting an instance does not let a later
  instance reuse its ports — pools only count up. Fine for casual/self-hosted
  use; would need revisiting for very long-lived installations.
- **Single admin login**, no per-instance permissions in the hub UI itself
  (each instance still has its own independent admin login, unrelated to the
  hub's).
