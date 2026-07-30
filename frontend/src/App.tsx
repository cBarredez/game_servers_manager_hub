import { useEffect, useState } from "react";
import { authCheck, POST } from "./api/client.js";
import { Login } from "./sections/Login.js";
import { Dashboard } from "./sections/Dashboard.js";

export function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

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
        <span className="topbar-user">{username}</span>
        <button onClick={logout}>Log out</button>
      </header>
      <main className="content">
        <Dashboard />
      </main>
    </div>
  );
}
