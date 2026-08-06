export interface HubDeploymentStatus {
  currentCommit: string;
  buildDate: string | null;
  deploymentMode: "external";
  updateAvailable: null;
  message: string;
}

/**
 * The running hub is deliberately not allowed to replace itself. Its image,
 * Quadlet unit, SQLite backup and rollback are owned by the external
 * deploy.py bootstrap, which remains available even when the hub is down.
 */
export class HubDeploymentService {
  constructor(
    private readonly commit: string,
    private readonly buildDate: string | null,
  ) {}

  getStatus(): HubDeploymentStatus {
    return {
      currentCommit: this.commit,
      buildDate: this.buildDate,
      deploymentMode: "external",
      updateAvailable: null,
      message: "Hub updates are managed externally with deploy.py.",
    };
  }
}
