import { LogIn, LogOut } from "lucide-react";

import Flex from "@/components/ui/flex";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

import { useWorkspaceSession } from "./workspace-shell-session-context";

interface WorkspaceShellAccountProps {
  onNavigate?: () => void;
}

export default function WorkspaceShellAccount({
  onNavigate,
}: WorkspaceShellAccountProps) {
  const session = useWorkspaceSession();

  function openAuth() {
    onNavigate?.();
    session.openAuth();
  }

  if (session.user) {
    return (
      <Flex className="mt-6 justify-between rounded-xl border border-zinc-200 bg-zinc-50 p-2.5">
        <Flex className="min-w-0 gap-2">
          <Avatar size="sm">
            <AvatarFallback className="bg-zinc-900 text-[10px] text-white">
              {session.user.username.slice(0, 3)}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0">
            <p className="truncate text-xs font-semibold">
              {session.user.username}
            </p>
            <p className="text-[10px] text-muted-foreground">Signed in</p>
          </div>
        </Flex>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void session.signOut()}
          aria-label="Log out"
        >
          <LogOut aria-hidden="true" />
        </Button>
      </Flex>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full h-10"
      disabled={session.status === "loading"}
      onClick={openAuth}
    >
      <LogIn aria-hidden="true" data-icon="inline-start" />
      {session.status === "loading" ? "Checking session…" : "Login"}
    </Button>
  );
}
