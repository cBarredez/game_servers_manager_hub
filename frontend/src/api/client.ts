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
export const deleteInstance = (id: string, removeVolumes: boolean): Promise<{ ok: true }> =>
  DELETE(`/api/instances/${id}`, { removeVolumes });

export interface InstanceCredentials {
  username: string;
  password: string;
}

export const getCredentials = (id: string): Promise<InstanceCredentials> =>
  GET<InstanceCredentials>(`/api/instances/${id}/credentials`);

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
