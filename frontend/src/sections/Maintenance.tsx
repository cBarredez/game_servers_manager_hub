import { useEffect, useState } from "react";
import {
  getImageStatus,
  getMaintenanceSettings,
  listMaintenanceLog,
  pullLatest,
  rebuildImage,
  updateMaintenanceSettings,
  type GameImageStatus,
  type MaintenanceLogEntry,
  type MaintenanceSettings as MaintenanceSettingsType,
} from "../api/client.js";

const shortCommit = (commit: string | null) => (commit ? commit.slice(0, 10) : "unknown");

export function Maintenance() {
  const [settings, setSettings] = useState<MaintenanceSettingsType | null>(null);
  const [games, setGames] = useState<GameImageStatus[]>([]);
  const [log, setLog] = useState<MaintenanceLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [rebuilding, setRebuilding] = useState<string | null>(null);
  const [pulling, setPulling] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [settingsRes, imageRes, logRes] = await Promise.all([
        getMaintenanceSettings(),
        getImageStatus(),
        listMaintenanceLog(50),
      ]);
      setSettings(settingsRes);
      setGames(imageRes.games);
      setLog(logRes.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, []);

  const saveSettings = async (patch: Partial<MaintenanceSettingsType>) => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      setSettings(await updateMaintenanceSettings(patch));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSettings(false);
    }
  };

  const doRebuild = async (gameType: string) => {
    setRebuilding(gameType);
    setError(null);
    setSuccessMessage(null);
    try {
      const result = await rebuildImage(gameType as GameImageStatus["gameType"]);
      await refresh();
      const commitNote = result.apiCommit ? ` (commit ${result.apiCommit.slice(0, 10)})` : "";
      setSuccessMessage(
        `${gameType} image rebuilt successfully${commitNote}. Already-running instances stay on their old ` +
          `image until you click "Recreate from latest image" on each one from the dashboard.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebuilding(null);
    }
  };

  const doPull = async (gameType: string) => {
    setPulling(gameType);
    setError(null);
    setSuccessMessage(null);
    try {
      const result = await pullLatest(gameType as GameImageStatus["gameType"]);
      await refresh();
      if (result.success) {
        setSuccessMessage(
          `${gameType}: ${result.message || "already up to date"}. Click "Rebuild image" to build the ` +
            `updated code into a new image.`,
        );
      } else {
        setError(`${gameType} pull failed: ${result.message}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPulling(null);
    }
  };

  if (!settings) {
    return <p className="dashboard-empty">Loading…</p>;
  }

  return (
    <div className="maintenance">
      {error && <p role="alert">{error}</p>}
      {successMessage && <p className="maintenance-success">{successMessage}</p>}

      <section className="maintenance-section">
        <h2>Settings</h2>
        <div className="maintenance-settings-grid">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.crashRestartEnabled}
              disabled={savingSettings}
              onChange={(e) => saveSettings({ crashRestartEnabled: e.target.checked })}
            />
            Auto-restart crashed instances
          </label>
          <label>
            Max restart attempts
            <input
              type="number"
              min={1}
              value={settings.maxCrashRestarts}
              disabled={savingSettings}
              onChange={(e) => saveSettings({ maxCrashRestarts: Number(e.target.value) })}
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.cleanupEnabled}
              disabled={savingSettings}
              onChange={(e) => saveSettings({ cleanupEnabled: e.target.checked })}
            />
            Daily dangling-image cleanup
          </label>
          <label>
            Cleanup time (host-local)
            <input
              type="time"
              value={settings.cleanupTime}
              disabled={savingSettings}
              onChange={(e) => saveSettings({ cleanupTime: e.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="maintenance-section">
        <h2>Game images</h2>
        <div className="image-status-grid">
          {games.map((game) => (
            <div className="image-status-card" key={game.gameType}>
              <h3>{game.displayName}</h3>
              <dl>
                <dt>Source commit</dt>
                <dd>
                  <code>{shortCommit(game.currentCommit)}</code>
                </dd>
                <dt>Built from</dt>
                <dd>
                  <code>{shortCommit(game.builtCommit)}</code>
                </dd>
              </dl>
              {game.outdatedInstances.length > 0 && (
                <p className="image-outdated-badge">
                  {game.outdatedInstances.length} instance{game.outdatedInstances.length === 1 ? "" : "s"} outdated
                </p>
              )}
              <div className="image-status-actions">
                <button
                  disabled={
                    pulling === game.gameType || rebuilding === game.gameType || game.pulling || game.rebuilding
                  }
                  onClick={() => doPull(game.gameType)}
                >
                  {pulling === game.gameType || game.pulling ? "Pulling…" : "Pull latest"}
                </button>
                <button
                  disabled={
                    rebuilding === game.gameType || pulling === game.gameType || game.rebuilding || game.pulling
                  }
                  onClick={() => doRebuild(game.gameType)}
                >
                  {rebuilding === game.gameType || game.rebuilding
                    ? "Rebuilding… (this can take a few minutes, especially the first time)"
                    : "Rebuild image"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="maintenance-section">
        <h2>Recent activity</h2>
        {log.length === 0 ? (
          <p className="dashboard-empty">Nothing yet.</p>
        ) : (
          <div className="maintenance-log-wrap">
            <table className="maintenance-log">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Scope</th>
                  <th>Action</th>
                  <th>Detail</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {log.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.timestamp}</td>
                    <td>{entry.scope}</td>
                    <td>{entry.action}</td>
                    <td>{entry.detail}</td>
                    <td>{entry.success ? "OK" : "Failed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
