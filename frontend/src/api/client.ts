async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data.error === "string" ? data.error : `request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

export const GET = <T>(path: string): Promise<T> => request<T>("GET", path);
export const POST = <T>(path: string, body?: unknown): Promise<T> => request<T>("POST", path, body);
export const PUT = <T>(path: string, body?: unknown): Promise<T> => request<T>("PUT", path, body);
export const DELETE = <T>(path: string, body?: unknown): Promise<T> => request<T>("DELETE", path, body);

export interface AuthCheckResponse {
  authenticated: boolean;
  username?: string;
}

export const authCheck = (): Promise<AuthCheckResponse> => GET<AuthCheckResponse>("/api/auth/check");

export type GameType = "arma3" | "pz";

export interface GameTemplateInfo {
  gameType: GameType;
  displayName: string;
  defaultMemoryMb: number;
}

export type InstanceStatus = "running" | "stopped" | "degraded" | "creating" | "deleting" | "error";

export interface InstanceSummary {
  id: string;
  slug: string;
  gameType: GameType;
  gameDisplayName: string;
  name: string;
  lifecycle: string;
  errorMessage: string | null;
  status: InstanceStatus;
  ports: Record<string, number>;
  panelUrl: string;
  createdAt: string;
  memoryMb: number;
  diskGb: number;
  desiredState: "running" | "stopped";
  restartSchedule: string | null;
  crashRestartCount: number;
}

export const listTemplates = (): Promise<{ templates: GameTemplateInfo[] }> =>
  GET<{ templates: GameTemplateInfo[] }>("/api/templates");

export const listInstances = (): Promise<{ instances: InstanceSummary[] }> =>
  GET<{ instances: InstanceSummary[] }>("/api/instances");

export const createInstance = (
  gameType: GameType,
  name: string,
  mock: boolean,
  memoryMb: number,
  diskGb: number,
): Promise<{ instance: InstanceSummary; initialPassword: string; diskLimitEnforced: boolean }> =>
  POST("/api/instances", { gameType, name, mock, memoryMb, diskGb });

export const startInstance = (id: string): Promise<{ ok: true }> => POST(`/api/instances/${id}/start`);
export const stopInstance = (id: string): Promise<{ ok: true }> => POST(`/api/instances/${id}/stop`);
export const restartInstance = (id: string): Promise<{ ok: true }> => POST(`/api/instances/${id}/restart`);
export const recreateInstance = (id: string): Promise<{ ok: true }> => POST(`/api/instances/${id}/recreate`);
export const deleteInstance = (id: string, removeVolumes: boolean): Promise<{ ok: true }> =>
  DELETE(`/api/instances/${id}`, { removeVolumes });
export const setInstanceSchedule = (id: string, time: string | null): Promise<{ ok: true }> =>
  PUT(`/api/instances/${id}/schedule`, { time });

export interface InstanceCredentials {
  username: string;
  password: string;
}

export const getCredentials = (id: string): Promise<InstanceCredentials> =>
  GET<InstanceCredentials>(`/api/instances/${id}/credentials`);

export interface MaintenanceSettings {
  cleanupEnabled: boolean;
  cleanupTime: string;
  crashRestartEnabled: boolean;
  maxCrashRestarts: number;
}

export const getMaintenanceSettings = (): Promise<MaintenanceSettings> =>
  GET<MaintenanceSettings>("/api/maintenance/settings");
export const updateMaintenanceSettings = (patch: Partial<MaintenanceSettings>): Promise<MaintenanceSettings> =>
  PUT<MaintenanceSettings>("/api/maintenance/settings", patch);

export interface MaintenanceLogEntry {
  id: number;
  timestamp: string;
  scope: "instance" | "image" | "host";
  instanceId: string | null;
  gameType: GameType | null;
  action: string;
  detail: string | null;
  success: boolean;
}

export const listMaintenanceLog = (limit = 50): Promise<{ entries: MaintenanceLogEntry[] }> =>
  GET<{ entries: MaintenanceLogEntry[] }>(`/api/maintenance/log?limit=${limit}`);

export interface GameImageStatus {
  gameType: GameType;
  displayName: string;
  currentCommit: string | null;
  builtCommit: string | null;
  builtAt: string | null;
  outdatedInstances: { id: string; name: string }[];
  rebuilding: boolean;
}

export const getImageStatus = (): Promise<{ games: GameImageStatus[] }> =>
  GET<{ games: GameImageStatus[] }>("/api/maintenance/image-status");

export const rebuildImage = (gameType: GameType): Promise<{ apiCommit: string | null; builtAt: string }> =>
  POST(`/api/maintenance/images/${gameType}/rebuild`);

export function statusPresentation(status: InstanceStatus): {
  label: string;
  tone: "neutral" | "positive" | "warning" | "negative";
} {
  switch (status) {
    case "running":
      return { label: "Running", tone: "positive" };
    case "creating":
      return { label: "Creating…", tone: "warning" };
    case "deleting":
      return { label: "Deleting…", tone: "warning" };
    case "degraded":
      return { label: "Degraded", tone: "warning" };
    case "error":
      return { label: "Error", tone: "negative" };
    case "stopped":
    default:
      return { label: "Stopped", tone: "neutral" };
  }
}
