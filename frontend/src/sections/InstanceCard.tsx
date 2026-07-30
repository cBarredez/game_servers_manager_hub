import { useState } from "react";
import {
  formatBytes,
  getCredentials,
  statusPresentation,
  type InstanceCredentials,
  type InstanceMetrics,
  type InstanceSummary,
} from "../api/client.js";

const GAME_IMAGE: Record<string, string> = {
  arma3: "/games/arma3.jpg",
  pz: "/games/pz.jpg",
};

export function InstanceCard({
  instance,
  outdated,
  metrics,
  onStart,
  onStop,
  onRestart,
  onRecreate,
  onSetSchedule,
  onDelete,
}: {
  instance: InstanceSummary;
  outdated: boolean;
  metrics: InstanceMetrics | undefined;
  onStart: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onRestart: (id: string) => Promise<void>;
  onRecreate: (id: string) => Promise<void>;
  onSetSchedule: (id: string, time: string | null) => Promise<void>;
  onDelete: (id: string, removeVolumes: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<InstanceCredentials | null>(null);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const presentation = statusPresentation(instance.status);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleCredentials = async () => {
    if (credentialsOpen) {
      setCredentialsOpen(false);
      return;
    }
    if (!credentials) {
      setCredentialsBusy(true);
      setError(null);
      try {
        setCredentials(await getCredentials(instance.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setCredentialsBusy(false);
      }
    }
    setCredentialsOpen(true);
  };

  const portEntries = Object.entries(instance.ports).filter(([key]) => key !== "web");

  return (
    <div className="instance-card">
      <img className="instance-cover" src={GAME_IMAGE[instance.gameType]} alt={instance.gameDisplayName} />

      <div className="instance-card-header">
        <div>
          <h3>{instance.name}</h3>
          <span className="instance-game">{instance.gameDisplayName}</span>
        </div>
        <span className={`status-pill status-${presentation.tone}`}>{presentation.label}</span>
      </div>

      {outdated && <p className="image-outdated-badge">Outdated image — a newer build is available</p>}

      {error && (
        <p role="alert" className="instance-error">
          {error}
        </p>
      )}
      {instance.status === "error" && instance.errorMessage && (
        <p role="alert" className="instance-error">
          {instance.errorMessage}
        </p>
      )}

      <dl className="instance-ports">
        <div>
          <dt>Web</dt>
          <dd>{instance.ports.web}</dd>
        </div>
        {portEntries.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <dl className="instance-metrics">
        <div>
          <dt>CPU</dt>
          <dd>{metrics?.cpuPercent !== null && metrics?.cpuPercent !== undefined ? `${metrics.cpuPercent.toFixed(1)}%` : "—"}</dd>
        </div>
        <div>
          <dt>RAM</dt>
          <dd>
            {metrics?.memUsedBytes !== null && metrics?.memUsedBytes !== undefined
              ? `${formatBytes(metrics.memUsedBytes)} / ${formatBytes(metrics.memLimitBytes)}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Disk</dt>
          <dd>{metrics ? formatBytes(metrics.diskUsedBytes) : "—"}</dd>
        </div>
      </dl>

      {credentialsOpen && credentials && (
        <dl className="credential-list credential-list-inline">
          <dt>Username</dt>
          <dd>{credentials.username}</dd>
          <dt>Password</dt>
          <dd>
            <code>{credentials.password}</code>
          </dd>
        </dl>
      )}

      <label className="instance-schedule-row">
        Daily restart
        <input
          type="time"
          value={instance.restartSchedule ?? ""}
          onChange={(e) => run(() => onSetSchedule(instance.id, e.target.value || null))}
        />
        {instance.restartSchedule && (
          <button
            type="button"
            className="btn-icon"
            title="Clear scheduled restart"
            onClick={() => run(() => onSetSchedule(instance.id, null))}
          >
            ✕
          </button>
        )}
      </label>

      <div className="instance-actions">
        <a href={instance.panelUrl} target="_blank" rel="noreferrer" className="btn-primary">
          Open panel
        </a>
        <button disabled={credentialsBusy} onClick={toggleCredentials}>
          {credentialsBusy ? "Loading…" : credentialsOpen ? "Hide credentials" : "Show credentials"}
        </button>
        {instance.status === "running" ? (
          <>
            <button disabled={busy} onClick={() => run(() => onStop(instance.id))}>
              Stop
            </button>
            <button disabled={busy} onClick={() => run(() => onRestart(instance.id))}>
              Restart
            </button>
          </>
        ) : (
          <button
            disabled={busy || instance.status === "creating" || instance.status === "deleting"}
            onClick={() => run(() => onStart(instance.id))}
          >
            Start
          </button>
        )}
        {outdated && (
          <button disabled={busy} onClick={() => run(() => onRecreate(instance.id))}>
            Recreate from latest image
          </button>
        )}

        {confirmingDelete ? (
          <span className="instance-confirm-delete">
            <button className="btn-danger" disabled={busy} onClick={() => run(() => onDelete(instance.id, true))}>
              Delete + wipe data
            </button>
            <button disabled={busy} onClick={() => run(() => onDelete(instance.id, false))}>
              Delete, keep volumes
            </button>
            <button disabled={busy} onClick={() => setConfirmingDelete(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="btn-danger" disabled={busy} onClick={() => setConfirmingDelete(true)}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
