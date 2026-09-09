import { useEffect, useState, type ReactNode } from "react";

import authService, {
  type AuthenticatedUser,
  type LoginCredentials,
  type RegisterCredentials,
} from "@/services/auth";

import WorkspaceShellAuthDialog, {
  type WorkspaceShellAuthMode,
} from "./workspace-shell-auth-dialog";
import WorkspaceShellSessionContext, {
  type WorkspaceSessionStatus,
} from "./workspace-shell-session-context";

interface WorkspaceShellSessionProps {
  children: ReactNode;
}

export default function WorkspaceShellSession({
  children,
}: WorkspaceShellSessionProps) {
  const [authOpen, setAuthOpen] = useState(false);
  const [status, setStatus] = useState<WorkspaceSessionStatus>("loading");
  const [user, setUser] = useState<AuthenticatedUser | null>(null);

  useEffect(() => {
    let active = true;

    void authService.session().then((sessionUser) => {
      if (!active) return;
      setUser(sessionUser);
      setStatus(sessionUser ? "authenticated" : "guest");
    });

    return () => {
      active = false;
    };
  }, []);

  async function authenticate(
    mode: WorkspaceShellAuthMode,
    credentials: LoginCredentials | RegisterCredentials,
  ) {
    const authenticatedUser =
      mode === "login"
        ? await authService.login(credentials)
        : await authService.register(credentials as RegisterCredentials);

    setUser(authenticatedUser);
    setStatus("authenticated");
    setAuthOpen(false);
  }

  async function signOut() {
    try {
      await authService.logout();
    } finally {
      setUser(null);
      setStatus("guest");
    }
  }

  return (
    <WorkspaceShellSessionContext.Provider
      value={{
        openAuth: () => setAuthOpen(true),
        signOut,
        status,
        user,
      }}
    >
      {children}

      <WorkspaceShellAuthDialog
        open={authOpen}
        onAuthenticate={authenticate}
        onOpenChange={setAuthOpen}
      />
    </WorkspaceShellSessionContext.Provider>
  );
}
