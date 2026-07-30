import { useState } from "react";
import { createInstance, type GameTemplateInfo, type GameType, type InstanceSummary } from "../api/client.js";

export function NewInstanceModal({
  templates,
  onClose,
  onCreated,
}: {
  templates: GameTemplateInfo[];
  onClose: () => void;
  onCreated: (instance: InstanceSummary) => void;
}) {
  const firstTemplate = templates[0];
  const [gameType, setGameType] = useState<GameType | "">(firstTemplate?.gameType ?? "");
  const [name, setName] = useState("");
  const [mock, setMock] = useState(false);
  const [memoryMb, setMemoryMb] = useState(firstTemplate?.defaultMemoryMb ?? 4096);
  const [diskGb, setDiskGb] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    instance: InstanceSummary;
    initialPassword: string;
    diskLimitEnforced: boolean;
  } | null>(null);

  const selectGame = (value: GameType) => {
    setGameType(value);
    const template = templates.find((t) => t.gameType === value);
    if (template) setMemoryMb(template.defaultMemoryMb);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gameType || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createInstance(gameType, name.trim(), mock, memoryMb, diskGb);
      setResult(created);
      onCreated(created.instance);
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
            <h2>Instance created</h2>
            <p>
              <strong>{result.instance.name}</strong> ({result.instance.gameDisplayName}) is being provisioned.
            </p>
            <p>Initial panel login for that instance (shown only once):</p>
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
            <h2>New instance</h2>
            {error && <p role="alert">{error}</p>}
            <label>
              Game
              <select value={gameType} onChange={(e) => selectGame(e.target.value as GameType)} autoFocus>
                {templates.map((t) => (
                  <option key={t.gameType} value={t.gameType}>
                    {t.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Community Server" />
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
            <p className="field-hint">
              Disk limits only take effect if the host's storage backend supports quotas — you'll be told after
              creation if it couldn't be enforced.
            </p>
            <label className="checkbox-row">
              <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} />
              Mock mode (no real SteamCMD download — recommended for trying the hub out)
            </label>
            <div className="modal-actions">
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={busy || !gameType || !name.trim() || memoryMb < 512}
              >
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
