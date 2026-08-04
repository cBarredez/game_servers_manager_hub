import { useState } from "react";
import { claimDiscovery, type DiscoveryCandidate, type InstanceSummary } from "../api/client.js";

export function AdoptInstanceModal({
  candidate,
  onClose,
  onAdopted,
}: {
  candidate: DiscoveryCandidate;
  onClose: () => void;
  onAdopted: (instance: InstanceSummary) => void;
}) {
  const [name, setName] = useState(candidate.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await claimDiscovery(candidate.candidateId, name.trim());
      onAdopted(result.instance);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true">
        <form onSubmit={submit}>
          <h2>Adopt existing {candidate.displayName} instance</h2>
          {error && <p role="alert">{error}</p>}
          <p className="field-hint">
            The hub will claim and manage the existing containers <code>{candidate.manifest.resources.containers.api}</code>
            {" / "}<code>{candidate.manifest.resources.containers.frontend}</code>. It will not copy, rename, stop or delete
            containers, volumes, configuration or secrets during adoption.
          </p>
          <label>
            Instance name
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
              {busy ? "Adopting…" : "Adopt in place"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
