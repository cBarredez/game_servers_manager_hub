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
- Live CPU/RAM/disk usage per instance card (from `podman stats` and
  `podman system df -v`), polled independently of the status refresh since
  it's a heavier call.
- Search box on the dashboard to filter instances by name.
- A global rollup above the instance grid summing CPU/RAM/disk across every
  instance, plus a running/total count.
- Memory and disk limits can be changed at any time from an instance's card,
  not just at creation. Memory takes effect immediately (`podman update`
  live-changes a running container's limit, no restart needed); disk has no
  live equivalent in Podman, so a new value is saved and only applied the
  next time that instance is recreated.
- Unattended maintenance: auto-restart on crash, opt-in daily scheduled
  restarts, source-update tracking with one-click image rebuild + instance
  recreate, hub self-update, and daily dangling-image cleanup — see
  [Maintenance](#maintenance) below.

## Maintenance

A background scheduler (`infra/scheduler.ts`, ticks every 60s) drives most of
the automatic behaviors below; source-update checks (both for game images
and for the hub itself) are cheap enough to compute live on demand instead.
All of it is configurable from the **Maintenance** tab:

- **Auto-restart on crash**: if an instance's containers stop unexpectedly
  while it's supposed to be running (i.e. nobody clicked Stop), the hub
  restarts it automatically, up to a configurable attempt limit — past that,
  it stops trying and leaves the instance visibly `degraded` rather than
  restart-looping forever. A manual Start/Restart resets the counter. This
  is also what brings instances back after the host machine itself reboots:
  every instance's desired state lives in the hub's own SQLite database, not
  in memory, so it survives the hub process restarting along with everything
  else; the maintenance check runs once immediately on startup (not just on
  its normal 60s cadence) so instances that were running before a reboot
  don't sit down for up to a minute before the hub even notices. If Podman
  itself isn't reachable yet (its own machine/service can take a while to
  come up after a host reboot), the hub skips that check entirely instead of
  treating every instance as crashed and burning through their restart
  budgets for a reason that has nothing to do with the instances themselves.
- **Scheduled restarts**: optional per-instance daily restart time
  (`HH:MM`, host-local), set from the instance card. Fires at most once per
  day.
- **Image update tracking**: the hub stamps every instance with the git
  commit of `arma_server`/`proyect_zomboid` its image was built from. The
  Maintenance tab compares that against each repo's current `HEAD` and flags
  outdated instances live (no polling needed — it's just a couple of
  `git rev-parse` calls). "Pull latest" runs `git pull --ff-only` on the
  sibling repo (fails cleanly instead of merging/rebasing if it has
  diverged — e.g. someone hand-edited files on the host), "Rebuild image"
  builds fresh images for a game type from whatever is currently checked
  out, and "Recreate from latest image" swaps an individual instance onto
  them without touching its ports, volumes, or config. If that instance is
  currently running, the swap is deferred instead of applied immediately —
  it's marked "update queued" and applied automatically the next time the
  instance actually stops and starts again for any reason (manual
  Start/Restart, a scheduled restart, or crash recovery), so clicking
  Recreate never itself interrupts a live session. Pull and rebuild
  share a lock per game type so they can never run concurrently against the
  same working tree. **Limitation**: only detects committed changes to the
  sibling repos, not uncommitted local edits.
- **Hub self-update**: separate from the image tracking above — this is the
  hub's *own* source, not `arma_server`/`proyect_zomboid`. The Maintenance
  tab shows whether the hub's git remote has commits the running hub doesn't
  (`git fetch` + compare against `HEAD`). "Update & restart hub" runs
  `git pull --ff-only`, `npm install` (only if a `package.json`/
  `package-lock.json` actually changed), rebuilds both the backend and
  frontend, then hands off to a freshly-spawned process and exits — the page
  briefly loses connection during the handoff and reconnects on its own once
  the new process is listening. If the pull or build fails, nothing is
  touched: the current process keeps running exactly as before, and the
  failure shows up in the activity log instead of taking the hub down.
- **Automated host cleanup**: a daily dangling-image prune (same operation
  already run after every build), so cleanup doesn't depend on you
  remembering to do it manually.

Every maintenance action — auto-restarts, scheduled restarts, rebuilds,
recreates, cleanups — is recorded and visible in the Maintenance tab's
activity log.

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

Requires Node.js 24+ and Podman, **plus the two game-manager repos cloned as
siblings of `hub/`** — the hub has no game code of its own; it builds every
instance from their `Containerfile.api`/`Containerfile.frontend`:

```bash
git clone https://github.com/cBarredez/Arma3-server-manager.git arma_server
git clone https://github.com/cBarredez/Proyect_zomboid_manager.git proyect_zomboid
git clone https://github.com/cBarredez/game_servers_manager_hub.git hub
```

All three must sit side by side (`arma_server/`, `proyect_zomboid/`, `hub/`
under the same parent directory) — that layout is what `podman.repos_dir`
in `hub/config/manager.toml` (default `..`) resolves against. Creating an
Arma3 or PZ instance before cloning the matching repo will fail at the
image-build step.

Then, from `hub/`:

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
