import { useEffect, useState } from "react";
import { authCheck, POST } from "./api/client.js";
import { Login } from "./sections/Login.js";
import { Dashboard } from "./sections/Dashboard.js";
import { Maintenance } from "./sections/Maintenance.js";

type Section = "dashboard" | "maintenance";

export function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("dashboard");

  useEffect(() => {
    authCheck()
      .then((res) => setUsername(res.authenticated ? (res.username ?? null) : null))
      .catch((err) => setAuthError(err instanceof Error ? err.message : String(err)))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) {
    return (
      <div className="app-loading" role="status">
        Connecting to Server Hub…
      </div>
    );
  }

  if (!username) {
    return (
      <>
        {authError && (
          <div className="startup-error" role="alert">
            Cannot reach the API: {authError}
          </div>
        )}
        <Login onLoggedIn={setUsername} />
      </>
    );
  }

  const logout = async () => {
    await POST("/api/auth/logout");
    setUsername(null);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar-title">Server Hub</span>
        <nav className="topbar-nav">
          <button
            className={section === "dashboard" ? "is-active" : ""}
            aria-current={section === "dashboard" ? "page" : undefined}
            onClick={() => setSection("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={section === "maintenance" ? "is-active" : ""}
            aria-current={section === "maintenance" ? "page" : undefined}
            onClick={() => setSection("maintenance")}
          >
            Maintenance
          </button>
        </nav>
        <span className="topbar-user">{username}</span>
        <button onClick={logout}>Log out</button>
      </header>
      <main className="content">
        {section === "dashboard" && <Dashboard />}
        {section === "maintenance" && <Maintenance />}
      </main>
    </div>
  );
}
