import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sessionService } from "@/services/session/session-service";

/** Signs in with an ordinary Hub William account; staff are accounts too. */
export default function DashboardLoginForm() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () =>
      sessionService.login({ password, username: username.trim() }),
    onError: (error) =>
      toast.error("Could not log in", { description: error.message }),
    // The session query decides what comes next: the dashboard, or a refusal.
    onSuccess: (account) => {
      toast.success("Logged in", {
        description: `You are signed in as ${account}.`,
      });

      return queryClient.invalidateQueries({
        queryKey: sessionService.queryKey,
      });
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        login.mutate();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="login-username">Username</Label>

        <Input
          autoComplete="username"
          id="login-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="login-password">Password</Label>

        <Input
          autoComplete="current-password"
          id="login-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <Button
        className="w-full"
        disabled={username.trim() === "" || password === "" || login.isPending}
        size="lg"
        type="submit"
      >
        {login.isPending ? "Logging in…" : "Login"}
      </Button>
    </form>
  );
}
