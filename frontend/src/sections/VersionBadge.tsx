import { useEffect, useState } from "react";
import { getHealth, type HealthResponse } from "../api/client.js";

export function VersionBadge() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch(() => {
        // the badge is purely informational — a failed fetch just leaves it hidden
      });
  }, []);

  if (!health) return null;

  const short = health.commit === "unknown" ? "unknown" : health.commit.slice(0, 10);
  const title = health.buildDate ? `commit ${health.commit}\nbuilt ${health.buildDate}` : `commit ${health.commit}`;

  return (
    <div className="version-badge" title={title}>
      {short}
    </div>
  );
}
