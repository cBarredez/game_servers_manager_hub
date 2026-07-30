import { useEffect, useState } from "react";
import {
  deleteInstance,
  getImageStatus,
  listInstances,
  listTemplates,
  recreateInstance,
  restartInstance,
  setInstanceSchedule,
  startInstance,
  stopInstance,
  type GameTemplateInfo,
  type InstanceSummary,
} from "../api/client.js";
import { InstanceCard } from "./InstanceCard.js";
import { NewInstanceModal } from "./NewInstanceModal.js";

const POLL_MS = 5000;

export function Dashboard() {
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [templates, setTemplates] = useState<GameTemplateInfo[]>([]);
  const [outdatedIds, setOutdatedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewInstance, setShowNewInstance] = useState(false);

  const refresh = async () => {
    try {
      const [instancesRes, imageRes] = await Promise.all([listInstances(), getImageStatus()]);
      setInstances(instancesRes.instances);
      setOutdatedIds(new Set(imageRes.games.flatMap((g) => g.outdatedInstances.map((i) => i.id))));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    listTemplates().then((res) => setTemplates(res.templates));
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  const removeFromList = (id: string) => setInstances((prev) => prev.filter((i) => i.id !== id));

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Instances</h1>
        <button className="btn-primary" onClick={() => setShowNewInstance(true)} disabled={templates.length === 0}>
          + New instance
        </button>
      </div>

      {error && <p role="alert">{error}</p>}

      {loading ? (
        <p className="dashboard-empty">Loading…</p>
      ) : instances.length === 0 ? (
        <p className="dashboard-empty">No instances yet. Create one to get started.</p>
      ) : (
        <div className="instance-grid">
          {instances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              outdated={outdatedIds.has(instance.id)}
              onStart={async (id) => {
                await startInstance(id);
                await refresh();
              }}
              onStop={async (id) => {
                await stopInstance(id);
                await refresh();
              }}
              onRestart={async (id) => {
                await restartInstance(id);
                await refresh();
              }}
              onRecreate={async (id) => {
                await recreateInstance(id);
                await refresh();
              }}
              onSetSchedule={async (id, time) => {
                await setInstanceSchedule(id, time);
                await refresh();
              }}
              onDelete={async (id, removeVolumes) => {
                await deleteInstance(id, removeVolumes);
                removeFromList(id);
              }}
            />
          ))}
        </div>
      )}

      {showNewInstance && (
        <NewInstanceModal
          templates={templates}
          onClose={() => {
            setShowNewInstance(false);
            refresh();
          }}
          onCreated={(instance) => setInstances((prev) => [...prev, instance])}
        />
      )}
    </div>
  );
}
