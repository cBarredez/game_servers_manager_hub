import { useState } from "react";
import { importStandalone, type GameTemplateInfo, type InstanceSummary, type StandaloneDetection } from "../api/client.js";

export function ImportStandaloneModal({
  detection,
  template,
  onClose,
  onImported,
}: {
  detection: StandaloneDetection;
  template: GameTemplateInfo;
  onClose: () => void;
  onImported: (instance: InstanceSummary) => void;
}) {
  const [name, setName] = useState("");
  const [memoryMb, setMemoryMb] = useState(template.defaultMemoryMb);
  const [diskGb, setDiskGb] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    instance: InstanceSummary;
    initialPassword: string;
    diskLimitEnforced: boolean;
  } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await importStandalone(detection.gameType, name.trim(), memoryMb, diskGb);
      setResult(imported);
      onImported(imported.instance);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" role="presentation" onClick={result ? onClose : undefined}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {result ? (
          <>
            <h2>Imported</h2>
            <p>
              <strong>{result.instance.name}</strong> ({result.instance.gameDisplayName}) now has its own copy of
              the data from <code>{detection.apiContainer}</code> / <code>{detection.frontendContainer}</code>.
              Those original containers and volumes were not touched — they're still there.
            </p>
            <p>Initial panel login for the new instance (shown only once):</p>
            <dl className="credential-list">
              <dt>Username</dt>
              <dd>admin</dd>
              <dt>Password</dt>
              <dd>
                <code>{result.initialPassword}</code>
              </dd>
            </dl>
            {diskGb > 0 && !result.diskLimitEnforced && (
              <p role="alert">
                Heads up: this host's storage doesn't support disk quotas, so the {diskGb} GB limit you set was
                <strong> not enforced</strong> — the instance can use as much disk as is available.
              </p>
            )}
            <div className="modal-actions">
              <button className="btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <h2>Import existing {template.displayName} deployment</h2>
            {error && <p role="alert">{error}</p>}
            <p className="field-hint">
              Found <code>{detection.apiContainer}</code> ({detection.apiStatus}) and{" "}
              <code>{detection.frontendContainer}</code> ({detection.frontendStatus}) on this host. This creates a
              new hub-managed instance and copies its data from {detection.volumes.join(", ")} — the source volumes
              are mounted <strong>read-only</strong> during the copy and are never modified, removed, or stopped.
              This can take a while for a large install; the original keeps running the whole time if it already
              is.
            </p>
            <label>
              Name for the new instance
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Community Server" autoFocus />
            </label>
            <label>
              Memory limit (MB)
              <input
                type="number"
                min={512}
                step={512}
                value={memoryMb}
                onChange={(e) => setMemoryMb(Number(e.target.value))}
              />
            </label>
            <label>
              Disk space limit (GB, 0 = unlimited)
              <input
                type="number"
                min={0}
                step={5}
                value={diskGb}
                onChange={(e) => setDiskGb(Number(e.target.value))}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={busy || !name.trim() || memoryMb < 512}>
                {busy ? "Importing…" : "Import"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
