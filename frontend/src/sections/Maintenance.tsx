import { useEffect, useState } from "react";
import {
  getImageStatus,
  getMaintenanceSettings,
  listMaintenanceLog,
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
  const [savingSettings, setSavingSettings] = useState(false);
  const [rebuilding, setRebuilding] = useState<string | null>(null);

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
    try {
      await rebuildImage(gameType as GameImageStatus["gameType"]);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebuilding(null);
    }
  };

  if (!settings) {
    return <p className="dashboard-empty">Loading…</p>;
  }

  return (
    <div className="maintenance">
      {error && <p role="alert">{error}</p>}

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
              <button disabled={rebuilding === game.gameType} onClick={() => doRebuild(game.gameType)}>
                {rebuilding === game.gameType ? "Rebuilding…" : "Rebuild image"}
              </button>
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
