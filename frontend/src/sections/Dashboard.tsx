import { useEffect, useState } from "react";
import {
  deleteInstance,
  detectStandalone,
  formatBytes,
  getAllMetrics,
  getImageStatus,
  listInstances,
  listTemplates,
  recreateInstance,
  restartInstance,
  setInstanceSchedule,
  startInstance,
  stopInstance,
  updateInstanceResources,
  type GameTemplateInfo,
  type InstanceMetrics,
  type InstanceSummary,
  type StandaloneDetection,
} from "../api/client.js";
import { ImportStandaloneModal } from "./ImportStandaloneModal.js";
import { InstanceCard } from "./InstanceCard.js";
import { NewInstanceModal } from "./NewInstanceModal.js";

const POLL_MS = 5000;
const METRICS_POLL_MS = 10_000;

function GlobalMetrics({
  instances,
  metricsById,
}: {
  instances: InstanceSummary[];
  metricsById: Record<string, InstanceMetrics>;
}) {
  const metricsList = Object.values(metricsById);
  const runningCount = instances.filter((i) => i.status === "running").length;
  const totalCpuPercent = metricsList.reduce((sum, m) => sum + (m.cpuPercent ?? 0), 0);
  const withMem = metricsList.filter((m) => m.memUsedBytes !== null && m.memLimitBytes !== null);
  const totalMemUsed = withMem.reduce((sum, m) => sum + (m.memUsedBytes ?? 0), 0);
  const totalMemLimit = withMem.reduce((sum, m) => sum + (m.memLimitBytes ?? 0), 0);
  const totalDiskUsed = metricsList.reduce((sum, m) => sum + m.diskUsedBytes, 0);

  return (
    <div className="global-metrics">
      <div className="global-metric-tile">
        <span className="global-metric-label">Instances</span>
        <span className="global-metric-value">
          {runningCount} / {instances.length} running
        </span>
      </div>
      <div className="global-metric-tile">
        <span className="global-metric-label">Total CPU</span>
        <span className="global-metric-value">{totalCpuPercent.toFixed(1)}%</span>
      </div>
      <div className="global-metric-tile">
        <span className="global-metric-label">Total RAM</span>
        <span className="global-metric-value">
          {withMem.length > 0 ? `${formatBytes(totalMemUsed)} / ${formatBytes(totalMemLimit)}` : "—"}
        </span>
      </div>
      <div className="global-metric-tile">
        <span className="global-metric-label">Total disk</span>
        <span className="global-metric-value">{formatBytes(totalDiskUsed)}</span>
      </div>
    </div>
  );
}

export function Dashboard() {
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [templates, setTemplates] = useState<GameTemplateInfo[]>([]);
  const [outdatedIds, setOutdatedIds] = useState<Set<string>>(new Set());
  const [metricsById, setMetricsById] = useState<Record<string, InstanceMetrics>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewInstance, setShowNewInstance] = useState(false);
  const [search, setSearch] = useState("");
  const [standaloneDetections, setStandaloneDetections] = useState<StandaloneDetection[]>([]);
  const [importingGameType, setImportingGameType] = useState<StandaloneDetection | null>(null);

  const checkStandalone = async (templateList: GameTemplateInfo[]) => {
    const results = await Promise.all(
      templateList.map((t) => detectStandalone(t.gameType).catch(() => ({ detection: null }))),
    );
    setStandaloneDetections(results.map((r) => r.detection).filter((d): d is StandaloneDetection => d !== null));
  };

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

  const refreshMetrics = async () => {
    try {
      const res = await getAllMetrics();
      setMetricsById(res.metrics);
    } catch {
      // metrics are supplementary — a failed fetch just leaves the last-known values showing
    }
  };

  useEffect(() => {
    listTemplates().then((res) => {
      setTemplates(res.templates);
      checkStandalone(res.templates);
    });
    refresh();
    refreshMetrics();
    const interval = setInterval(refresh, POLL_MS);
    const metricsInterval = setInterval(refreshMetrics, METRICS_POLL_MS);
    return () => {
      clearInterval(interval);
      clearInterval(metricsInterval);
    };
  }, []);

  const removeFromList = (id: string) => setInstances((prev) => prev.filter((i) => i.id !== id));

  const query = search.trim().toLowerCase();
  const filteredInstances = query ? instances.filter((i) => i.name.toLowerCase().includes(query)) : instances;

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Instances</h1>
        <input
          type="search"
          className="instance-search"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search instances by name"
        />
        <button className="btn-primary" onClick={() => setShowNewInstance(true)} disabled={templates.length === 0}>
          + New instance
        </button>
      </div>

      {error && <p role="alert">{error}</p>}

      {standaloneDetections.map((detection) => {
        const template = templates.find((t) => t.gameType === detection.gameType);
        if (!template) return null;
        return (
          <div className="standalone-banner" key={detection.gameType}>
            <span>
              Found an existing standalone {template.displayName} deployment on this host (
              <code>{detection.apiContainer}</code>: {detection.apiStatus}, <code>{detection.frontendContainer}</code>:{" "}
              {detection.frontendStatus}) that isn't managed by the hub yet.
            </span>
            <button onClick={() => setImportingGameType(detection)}>Import into hub</button>
          </div>
        );
      })}

      {!loading && instances.length > 0 && <GlobalMetrics instances={instances} metricsById={metricsById} />}

      {loading ? (
        <p className="dashboard-empty">Loading…</p>
      ) : instances.length === 0 ? (
        <p className="dashboard-empty">No instances yet. Create one to get started.</p>
      ) : filteredInstances.length === 0 ? (
        <p className="dashboard-empty">No instances match "{search.trim()}".</p>
      ) : (
        <div className="instance-grid">
          {filteredInstances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              outdated={outdatedIds.has(instance.id)}
              metrics={metricsById[instance.id]}
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
              onUpdateResources={async (id, memoryMb, diskGb) => {
                const result = await updateInstanceResources(id, memoryMb, diskGb);
                await refresh();
                return result;
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

      {importingGameType &&
        (() => {
          const template = templates.find((t) => t.gameType === importingGameType.gameType);
          if (!template) return null;
          return (
            <ImportStandaloneModal
              detection={importingGameType}
              template={template}
              onClose={() => {
                setImportingGameType(null);
                refresh();
              }}
              onImported={(instance) => setInstances((prev) => [...prev, instance])}
            />
          );
        })()}
    </div>
  );
}
