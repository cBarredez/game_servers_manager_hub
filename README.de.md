# Server Hub

**Sprachen:** [English](README.md) · [Español](README.es.md) · [Deutsch](README.de.md)

Multi-Game-Hosting-Hub: erstellen, starten/stoppen und löschen Sie
unabhängige **Instanzen** von `arma_server` und `proyect_zomboid` (und
zukünftigen Game-Managern) nebeneinander auf einer Maschine, über ein
einziges Panel.

Der Hub implementiert Mods/RCON/Backups/Sandbox-Bearbeitung nicht neu — jede
Instanz läuft weiterhin auf dem bestehenden, voll ausgestatteten
`arma_server`-/`proyect_zomboid`-Stack (eigene API- + Frontend-Container,
eigener SQLite-Zustand, eigener Admin-Login). Der Hub übernimmt nur die
Bereitstellung der Instanzen, verfolgt ihren Lebenszyklus und verlinkt auf
das jeweils eigene Panel.

## Verwandte Projekte

- [Arma 3 Server Manager](https://github.com/cBarredez/Arma3-server-manager) —
  das Einzelinstanz-Panel für Arma 3, von dem dieser Hub Kopien bereitstellt.
- [Project Zomboid Server Manager](https://github.com/cBarredez/Proyect_zomboid_manager) —
  das Einzelinstanz-Panel für Project Zomboid, von dem dieser Hub Kopien
  bereitstellt.

Beide werden als Geschwisterverzeichnisse (`arma_server/`, `proyect_zomboid/`)
neben `hub/` geklont; ihre `Containerfile.api`/`Containerfile.frontend`
werden direkt als Podman-Build-Kontext für jede vom Hub erstellte Instanz
verwendet.

## Funktionen

- Instanzen beider Spiele nebeneinander erstellen, auflisten,
  starten/stoppen/neustarten und löschen — jede vollständig isoliert
  (eigenes Netzwerk, eigene Volumes, Containernamen und Ports).
- Speicherlimit pro Instanz, direkt über das `--memory`-Flag des Containers
  durchgesetzt.
- Speicherplatzanforderung pro Instanz — wird durchgesetzt, wenn das
  Storage-Backend von Podman auf dem Host Volume-Quoten unterstützt; der Hub
  meldet klar, wenn das nicht möglich ist (die meisten Setups, einschließlich
  der üblichen ext4-/Overlay-Backends, unterstützen dies nicht).
- Vor jeder Portvergabe läuft eine aktive TCP/UDP-Verfügbarkeitsprüfung, damit
  eine neue Instanz weder mit einer anderen vom Hub verwalteten Instanz noch
  mit irgendetwas anderem kollidiert, das auf dem Host bereits lauscht (eine
  manuell laufende Kopie von `arma_server`/`proyect_zomboid`, eine andere
  Anwendung usw.).
- Anmeldedaten einer Instanz jederzeit über ihre Karte einsehen (live aus der
  bereits generierten Konfiguration dieser Instanz gelesen — nie ein zweites
  Mal gespeichert).
- Spiel-Titelbild auf jeder Instanzkarte.

## Architektur

| Schicht | Technologie |
|---|---|
| Backend | Node.js 24 + Fastify + TypeScript |
| Frontend | React 19 + Vite |
| Zustand | SQLite (better-sqlite3) — Instanzregister + Port-Pool-Zähler |
| Konfiguration | TOML |
| Orchestrierung | Podman-CLI, direkt aufgerufen (keine Compose-Dateien) |

```text
backend/src/
├── config/      Lader für das eigene manager.toml/manager.secrets.toml des Hubs
├── security/    scrypt-Passwort-Hashing + HMAC-signiertes Session-Cookie
├── infra/       podman.ts (execFile-Wrapper), portCheck.ts (Live-Port-
│                verfügbarkeit), sqliteStore.ts, portAllocator.ts
├── templates/   ein Modul pro unterstütztem Spiel: Ports, Volume-/Container-/
│                Netzwerknamen, manager.toml-/secrets-Generatoren, podman-
│                run-Argumente — arma3.ts und pz.ts
├── domain/      instanceManager.ts (create/list/start/stop/restart/delete/
│                credentials)
└── routes/      auth, templates, instances

frontend/src/
├── api/client.ts
├── public/games/       Steam-Titelbilder (arma3.jpg, pz.jpg)
└── sections/    Login, Dashboard, InstanceCard, NewInstanceModal
```

### So funktioniert das Erstellen einer Instanz

Für eine neue Instanz des Spiels `G`:

1. Ein Host-Port für das Webpanel der Instanz wird aus einem Pool
   zugewiesen, der von allen Spieltypen gemeinsam genutzt wird, dazu ein
   spielspezifischer Portblock aus einem eigenen Pool für `G` (siehe
   `templates/arma3.ts` / `templates/pz.ts` für die genauen Basiswerte/
   Schrittweiten — beide sind reine Funktionen, direkt neben jedem Template
   mit Unit-Tests versehen). Jeder Kandidaten-Port wird anschließend live
   auf dem Host geprüft (`infra/portCheck.ts`), bevor er festgelegt wird;
   bei Belegung wird zum nächsten übergegangen.
2. `manager.toml` + `manager.secrets.toml` werden geschrieben (Secrets mit
   `crypto.randomBytes` erzeugt, genau wie in
   `proyect_zomboid/scripts/setup.mjs`) und in
   `hub/data/instances/<slug>/config/` abgelegt, inklusive des angeforderten
   Speicherlimits.
3. Die Containerfiles von `G` werden pro Spieltyp einmalig gebaut, falls noch
   nicht vorhanden (`localhost/arma3-manager-api:latest` usw. — identische
   Image-Tags wie die, die die eigenen Compose-Dateien von
   `arma_server`/`proyect_zomboid` ohnehin bauen, sodass kein erneuter Build
   nötig ist, falls Sie diese bereits selbst gebaut haben).
4. Ein instanzeigenes Podman-Netzwerk sowie Volumes werden angelegt (mit dem
   Slug der Instanz als Suffix; das Haupt-Datenvolume erhält einen Versuch
   einer Größenbegrenzung, falls ein Speicherplatzlimit angefordert wurde),
   und die API-/Frontend-Container werden mit genau denselben Mounts/
   Umgebungsvariablen wie die bestehenden Einzelinstanz-`podman-compose.yml`-
   Dateien gestartet, nur parametrisiert nach Instanz und Speicher.

Das Löschen einer Instanz entfernt ihre Container, ihr Netzwerk und
(optional) ihre Volumes sowie ihr generiertes Konfigurationsverzeichnis.

## Einrichtung

Erfordert Node.js 24+ und Podman. Aus `hub/`:

```bash
npm install
npm run setup            # erzeugt config/manager.secrets.toml und gibt das Admin-Passwort einmalig aus
```

Entwicklung (zwei Terminals):

```bash
npm run dev:backend      # Fastify mit Reload, http://127.0.0.1:4000
npm run dev:frontend     # Vite-Dev-Server, http://127.0.0.1:5173, leitet /api an das Backend weiter
```

Produktionsnaher lokaler Betrieb:

```bash
npm run build:backend
npm run build:frontend
npm start                # liefert das gebaute Backend auf dem web.port aus config/manager.toml aus
```

Der Hub selbst läuft als einfacher Node-Prozess auf dem Host, **nicht**
innerhalb eines Containers — er benötigt direkten Zugriff auf die
`podman`-Binary des Hosts sowie auf die Geschwisterverzeichnisse
`arma_server`/`proyect_zomboid` als Build-Kontext, was sonst ein
Podman-in-Podman-Socket-Mounting ohne echten Nutzen in dieser
Größenordnung erfordern würde.

### Konfiguration

- `config/manager.toml`: eigener Web-Port/Bind/Benutzername des Hubs, dazu
  `podman.repos_dir` (wo `arma_server`/`proyect_zomboid` relativ zu `hub/`
  zu finden sind, Standard `..`) und `ports.web_base` (erster vergebener
  Host-Port für das Panel einer beliebigen Instanz).
- `config/manager.secrets.toml`: eigenes Admin-Passwort und Session-Secret
  des Hubs, erzeugt durch `npm run setup`.

Tests (reine Funktionen — Portvergabe-Berechnung, Live-Port-
Verfügbarkeitsprüfungen und Config-/Secrets-Generatoren — laufen größtenteils
ohne eine echte Podman-Instanz):

```bash
npm test
```

## Bekannte Einschränkungen

- **Keine Remote-Hosts.** Instanzen laufen ausschließlich auf der Maschine,
  auf der der Hub selbst läuft, über den lokalen Podman-Socket.
- **Speicherplatzlimits sind Best-Effort.** Sie werden nur auf Podman-
  Storage-Backends mit Unterstützung für Projekt-Quoten durchgesetzt (z. B.
  XFS); auf allem anderen legt der Hub das Volume trotzdem an, nur ohne
  Begrenzung, und weist ausdrücklich darauf hin.
- **Die Steam-Abfrage-Ports von Project Zomboid (8766/8767 UDP)** sind fest
  im PZ-Server-Binary verankert und werden weder über `manager.toml` noch
  über Startparameter von `proyect_zomboid` freigegeben. Der Hub vergibt
  trotzdem für jede PZ-Instanz eigene, unterschiedliche Host-seitige Ports
  dafür (das Remapping im Bridge-Netzwerk übernimmt das), sodass mehrere
  PZ-Instanzen gleichzeitig ohne Portkonflikt laufen können — einziger
  Effekt: die öffentliche Serverbrowser-Liste von Steam löst den
  Abfrage-Port für Instanzen jenseits der ersten möglicherweise nicht
  korrekt auf; direkte IP:Port-Verbindungen sind davon nicht betroffen.
- **Keine Freiliste für Ports.** Das Löschen einer Instanz erlaubt es
  späteren Instanzen nicht, ihre Ports wiederzuverwenden — die Pools zählen
  nur aufwärts. Für gelegentliche/selbst gehostete Nutzung ausreichend; für
  sehr langlebige Installationen müsste das überarbeitet werden.
- **Ein einziger Admin-Login**, keine instanzbezogenen Berechtigungen in der
  Hub-Oberfläche selbst (jede Instanz behält ihren eigenen, unabhängigen
  Admin-Login, unabhängig vom Hub).
