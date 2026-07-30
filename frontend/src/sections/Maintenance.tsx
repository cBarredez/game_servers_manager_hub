import { useEffect, useState } from "react";
import {
  getHealth,
  getHubStatus,
  getImageStatus,
  getMaintenanceSettings,
  listMaintenanceLog,
  pullLatest,
  rebuildImage,
  updateHub,
  updateMaintenanceSettings,
  type GameImageStatus,
  type HubUpdateStatus,
  type MaintenanceLogEntry,
  type MaintenanceSettings as MaintenanceSettingsType,
} from "../api/client.js";

const shortCommit = (commit: string | null) => (commit ? commit.slice(0, 10) : "unknown");
const formatBuiltAt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

export function Maintenance() {
  const [settings, setSettings] = useState<MaintenanceSettingsType | null>(null);
  const [games, setGames] = useState<GameImageStatus[]>([]);
  const [log, setLog] = useState<MaintenanceLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [rebuilding, setRebuilding] = useState<string | null>(null);
  const [pulling, setPulling] = useState<string | null>(null);
  const [hubStatus, setHubStatus] = useState<HubUpdateStatus | null>(null);
  const [hubUpdating, setHubUpdating] = useState(false);
  const [hubMessage, setHubMessage] = useState<string | null>(null);

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

  // Kept on its own interval/try-catch, separate from refresh() above: while
  // the hub is mid-restart this check will fail (connection reset), which
  // is expected and shouldn't flip the page-wide error banner — doHubUpdate
  // already shows a dedicated "restarting" message for that.
  const refreshHubStatus = async () => {
    try {
      setHubStatus(await getHubStatus());
    } catch {
      // transient — most likely the hub is between "pulled" and "listening again"
    }
  };

  useEffect(() => {
    refreshHubStatus();
    const interval = setInterval(refreshHubStatus, 15_000);
    return () => clearInterval(interval);
  }, []);

  const waitForHubRestart = async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const health = await getHealth();
        setHubMessage(`Hub restarted successfully on commit ${health.commit.slice(0, 10)}.`);
        await refreshHubStatus();
        return;
      } catch {
        // still restarting — keep polling
      }
    }
    setHubMessage("Hub did not come back online within 60s after updating — check it manually.");
  };

  const doHubUpdate = async () => {
    setHubUpdating(true);
    setHubMessage(null);
    try {
      const result = await updateHub();
      setHubMessage(result.message);
      if (result.restarting) {
        await waitForHubRestart();
      } else {
        await refreshHubStatus();
      }
    } catch {
      // The connection drops the instant the hub closes its listener to
      // restart, so a fetch error here is the expected/success path too.
      setHubMessage("Hub is restarting…");
      await waitForHubRestart();
    } finally {
      setHubUpdating(false);
    }
  };

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
        <h2>Hub</h2>
        <div className="image-status-grid">
          <div className="image-status-card">
            <h3>Server Hub</h3>
            <dl>
              <dt>Running commit</dt>
              <dd>
                <code>{shortCommit(hubStatus?.currentCommit ?? null)}</code>
              </dd>
              <dt>Latest on origin</dt>
              <dd>
                <code>{shortCommit(hubStatus?.remoteCommit ?? null)}</code>
              </dd>
            </dl>
            {hubStatus?.checkError && (
              <p className="image-outdated-badge">Couldn't check for updates: {hubStatus.checkError}</p>
            )}
            {hubStatus?.updateAvailable && !hubStatus.checkError && (
              <p className="image-outdated-badge">Update available</p>
            )}
            {hubMessage && <p className="maintenance-success">{hubMessage}</p>}
            <div className="image-status-actions">
              <button
                disabled={hubUpdating || hubStatus?.updating || !hubStatus?.updateAvailable}
                onClick={doHubUpdate}
              >
                {hubUpdating || hubStatus?.updating ? "Updating & restarting…" : "Update & restart hub"}
              </button>
            </div>
          </div>
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
                <dt>Built at</dt>
                <dd>{formatBuiltAt(game.builtAt)}</dd>
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
