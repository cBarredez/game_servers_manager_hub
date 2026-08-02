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
- Live-Anzeige von CPU-/RAM-/Speicherplatznutzung pro Instanz (über
  `podman stats` und `podman system df -v`), unabhängig von der
  Status-Aktualisierung abgefragt, da es ein aufwendigerer Aufruf ist.
- Suchfeld im Dashboard, um Instanzen nach Namen zu filtern.
- Eine globale Übersicht über dem Instanzraster, die CPU/RAM/Speicherplatz
  aller Instanzen summiert, sowie eine Zähler für laufend/gesamt.
- Speicher- und Plattenplatzlimits lassen sich jederzeit über die Karte
  einer Instanz ändern, nicht nur bei der Erstellung. Der Speicher wird
  sofort wirksam (`podman update` ändert das Limit eines laufenden
  Containers live, ohne Neustart); für Plattenplatz gibt es in Podman kein
  Live-Äquivalent, daher wird der neue Wert gespeichert und erst beim
  nächsten Recreate dieser Instanz angewendet.
- Unbeaufsichtigte Wartung: automatischer Neustart bei Absturz, optionale
  tägliche geplante Neustarts, Verfolgung von Quellcode-Updates mit
  Image-Neuerstellung und Instanz-Recreate per Klick, Selbstaktualisierung
  des Hubs, sowie tägliche Bereinigung verwaister Images — siehe
  [Wartung](#wartung) weiter unten.
- Erkennt eine eigenständige (vor dem Hub entstandene, manuell bereitgestellte)
  Kopie von `arma_server`/`proyect_zomboid`, die bereits auf dem Host läuft,
  und bietet "In Hub importieren" per Klick an — siehe
  [Ein bestehendes Deployment importieren](#ein-bestehendes-deployment-importieren)
  weiter unten.

## Wartung

Ein Hintergrund-Scheduler (`infra/scheduler.ts`, tickt alle 60s) steuert die
meisten der folgenden automatischen Funktionen; die Prüfung auf
Quellcode-Updates (sowohl für Spiel-Images als auch für den Hub selbst) ist
billig genug, um stattdessen live bei Bedarf berechnet zu werden. Alles davon
ist über den Tab **Maintenance** konfigurierbar:

- **Automatischer Neustart bei Absturz**: Wenn die Container einer Instanz
  unerwartet stoppen, während sie eigentlich laufen sollte (d. h. niemand hat
  auf Stop geklickt), startet der Hub sie automatisch neu, bis zu einem
  konfigurierbaren Versuchslimit — danach wird es aufgegeben und die Instanz
  bleibt sichtbar `degraded`, statt endlos neu gestartet zu werden. Ein
  manueller Start/Restart setzt den Zähler zurück. Das ist auch der
  Mechanismus, der Instanzen nach einem Neustart der Host-Maschine selbst
  zurückbringt: Der gewünschte Zustand jeder Instanz lebt in der eigenen
  SQLite-Datenbank des Hubs, nicht im Arbeitsspeicher, und übersteht so einen
  Neustart des Hub-Prozesses zusammen mit allem anderen; die
  Wartungsprüfung läuft beim Start sofort einmal (nicht erst nach dem
  normalen 60s-Takt), damit Instanzen, die vor einem Neustart liefen, nicht
  bis zu eine Minute lang stillstehen, bevor der Hub es überhaupt bemerkt.
  Ist Podman selbst noch nicht erreichbar (die eigene Machine/der Dienst
  kann nach einem Host-Neustart eine Weile brauchen), überspringt der Hub
  diese Prüfung komplett, statt jede Instanz als abgestürzt zu behandeln und
  deren Neustart-Budget aus einem Grund aufzubrauchen, der nichts mit den
  Instanzen selbst zu tun hat.
- **Geplante Neustarts**: optionale tägliche Neustartzeit pro Instanz
  (`HH:MM`, lokale Host-Zeit), einstellbar über die Instanzkarte. Löst
  höchstens einmal pro Tag aus.
- **Verfolgung von Image-Updates**: Der Hub vermerkt bei jeder Instanz den
  Git-Commit von `arma_server`/`proyect_zomboid`, aus dem ihr Image gebaut
  wurde. Der Maintenance-Tab vergleicht das live mit dem aktuellen `HEAD`
  jedes Repos und markiert veraltete Instanzen (kein Polling nötig — nur ein
  paar `git rev-parse`-Aufrufe). "Pull latest" führt `git pull --ff-only` im
  Geschwister-Repo aus (schlägt sauber fehl, statt zu mergen/rebasen, wenn
  es abweicht — etwa weil jemand Dateien direkt auf dem Host bearbeitet
  hat), "Rebuild image" baut frische Images für einen Spieltyp aus dem
  aktuell ausgecheckten Stand, und "Recreate from latest image" versetzt
  eine einzelne Instanz auf diese Images, ohne ihre Ports, Volumes oder
  Konfiguration anzutasten. Läuft diese Instanz gerade, wird der Wechsel
  nicht sofort ausgeführt, sondern aufgeschoben — sie wird als
  "Update wartet" markiert und automatisch angewendet, sobald die Instanz
  aus irgendeinem Grund das nächste Mal stoppt und wieder startet (manueller
  Start/Restart, ein geplanter Neustart oder eine Absturz-Wiederherstellung),
  sodass ein Klick auf Recreate niemals selbst eine laufende Sitzung
  unterbricht. Pull und Rebuild teilen sich eine Sperre pro
  Spieltyp, damit sie nie gleichzeitig auf demselben Arbeitsverzeichnis
  laufen. **Einschränkung**: erkennt nur committete Änderungen an den
  Geschwister-Repos, keine uncommitteten lokalen Bearbeitungen.
- **Hub-Selbstaktualisierung**: unabhängig von der Image-Verfolgung oben —
  hierbei geht es um den *eigenen* Quellcode des Hubs, nicht um
  `arma_server`/`proyect_zomboid`. Der Maintenance-Tab zeigt, ob das
  Git-Remote des Hubs Commits enthält, die der laufende Hub noch nicht hat
  (`git fetch` + Vergleich mit `HEAD`). "Update & restart hub" führt
  `git pull --ff-only` aus, dann `npm install` (nur falls sich tatsächlich
  ein `package.json`/`package-lock.json` geändert hat), baut sowohl Backend
  als auch Frontend neu und übergibt anschließend an einen frisch gestarteten
  Prozess, bevor er sich beendet — die Seite verliert dabei kurz die
  Verbindung und verbindet sich von selbst neu, sobald der neue Prozess
  lauscht. Schlagen Pull oder Build fehl, bleibt alles unangetastet: der
  aktuelle Prozess läuft unverändert weiter, und der Fehler erscheint im
  Aktivitätsprotokoll, statt den Hub lahmzulegen.
- **Automatische Host-Bereinigung**: eine tägliche Bereinigung verwaister
  Images (derselbe Vorgang, der bereits nach jedem Build läuft), damit die
  Bereinigung nicht davon abhängt, dass Sie sich daran erinnern, sie manuell
  auszuführen.

Jede Wartungsaktion — automatische Neustarts, geplante Neustarts,
Neuerstellungen, Recreates, Bereinigungen — wird protokolliert und ist im
Aktivitätsprotokoll des Maintenance-Tabs sichtbar.

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

### Ein bestehendes Deployment importieren

Lief `arma_server`/`proyect_zomboid` bereits auf dem Host, bevor Sie den Hub
zu benutzen begannen — auf die übliche Art bereitgestellt (`deploy.py` /
`deploy/remote.ts`, nicht über den Hub) —, erkennt das Dashboard das und
bietet an, es unter die Verwaltung des Hubs zu bringen, ohne von vorne
anzufangen. Es ist eine **Kopie**, kein Verschieben:

1. Die Erkennung sucht nach den tatsächlichen Produktions-Containernamen
   dieses Spiels (verifiziert anhand der echten Deploy-Skripte, nicht nur
   der lokalen `podman-compose.yml` für die Entwicklung — beide stimmen
   nicht immer überein; das echte Deployment von `proyect_zomboid` nutzt
   zum Beispiel andere Containernamen und ein Volume weniger als seine
   eigene Compose-Datei).
2. Der Import erstellt eine neue, vom Hub verwaltete Instanz genau wie
   Create (eigener Slug, eigene Ports, Netzwerk, Volumes, generierte
   Konfiguration, neuer Admin-Login) — und befüllt, bevor sie überhaupt
   gestartet wird, jedes neue Volume aus dem passenden eigenständigen
   Volume. Das Quell-Volume wird während dieser Kopie **nur lesend**
   eingebunden — das ist keine bloße Konvention, der Container kann
   physisch nicht hineinschreiben —, sodass eine fehlgeschlagene oder
   unvollständige Kopie niemals etwas am Original verlieren oder
   beschädigen kann und einfach erneut versucht werden kann.
3. Die ursprünglichen Container und Volumes werden nie gestoppt, entfernt
   oder sonst irgendwie angefasst — weder vor, während noch nach dem
   Import. Beide Kopien können beliebig lange parallel laufen; die alte
   aufzuräumen (falls gewünscht) ist ein separater, manueller Schritt.

Da jeder Spiel-Manager seine eigenen Einstellungen (aktive Mods,
Start-Schalter usw.) innerhalb seines Haupt-Datenvolumes speichert statt in
der eingebundenen Config-Datei, bringt der Import auch das mit, nicht nur
Spielstände — nur der Admin-Login des Panels wird für die importierte
Instanz neu generiert, genau wie bei jeder anderen vom Hub erstellten
Instanz.

## Einrichtung

Erfordert Node.js 24+ und Podman, **sowie die beiden Game-Manager-Repos als
Geschwisterverzeichnisse von `hub/` geklont** — der Hub enthält keinen
eigenen Spielcode; er baut jede Instanz aus deren
`Containerfile.api`/`Containerfile.frontend`:

```bash
git clone https://github.com/cBarredez/Arma3-server-manager.git arma_server
git clone https://github.com/cBarredez/Proyect_zomboid_manager.git proyect_zomboid
git clone https://github.com/cBarredez/game_servers_manager_hub.git hub
```

Alle drei müssen nebeneinander liegen (`arma_server/`, `proyect_zomboid/`,
`hub/` im selben übergeordneten Verzeichnis) — genau diese Anordnung löst
`podman.repos_dir` in `hub/config/manager.toml` auf (Standard `..`). Wird
eine Arma3- oder PZ-Instanz erstellt, bevor das passende Repo geklont
wurde, schlägt das beim Image-Build-Schritt fehl.

Anschließend, aus `hub/`:

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

Es gibt keinen Prozessmanager, der ihn überwacht (keine systemd-Unit, kein
pm2) — ihn zu stoppen bedeutet also, einfach einen normalen
Vordergrundprozess zu stoppen:

- Läuft er in einem Terminal (`npm start`, `npm run dev:backend`):
  `Strg+C` in diesem Terminal.
- Läuft er im Hintergrund / ohne angeschlossenes Terminal: finden und
  stoppen, was `web.port` (Standard 4000) geöffnet hält —
  ```powershell
  # Windows PowerShell
  Get-NetTCPConnection -LocalPort 4000 -State Listen |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```
  ```bash
  # Linux/macOS
  fuser -k 4000/tcp
  ```
  Die vom Hub verwalteten Instanzen laufen in jedem Fall weiter — das
  Stoppen des Hubs beendet nur das Panel und dessen eigene
  Wartungsautomatisierung (automatischer Neustart, geplante Neustarts,
  Bereinigung), nicht die Spieleserver selbst.

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
