import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sessionService } from "@/services/session/session-service";

// What the API accepts of an account: 3 to 32 letters, digits, underscores or
// hyphens; a password of 8 to 128 characters. The recovery email is asked for, as
// on the storefront, and only has to look like an address; the API is the judge.
const USERNAME = /^[A-Za-z0-9_-]{3,32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MINIMUM_PASSWORD = 8;
const MAXIMUM_PASSWORD = 128;

/**
 * Makes an ordinary Hub William account, the same one the storefront makes. It
 * signs in at once but is not staff: the owner adds it on the Staff page.
 */
export default function DashboardRegisterForm() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const register = useMutation({
    mutationFn: () =>
      sessionService.register({
        password,
        recoveryEmail: email.trim(),
        username: username.trim(),
      }),
    onError: (error) =>
      toast.error("Could not register", { description: error.message }),
    // The session query decides what comes next: the dashboard, for an owner the
    // server already knows, or the refusal that asks for a place on the staff list.
    onSuccess: (account) => {
      toast.success("Account created", {
        description: `You are signed in as ${account}.`,
      });

      return queryClient.invalidateQueries({
        queryKey: sessionService.queryKey,
      });
    },
  });

  const usernameValid = USERNAME.test(username.trim());
  const emailValid = EMAIL.test(email.trim());
  const passwordValid =
    password.length >= MINIMUM_PASSWORD && password.length <= MAXIMUM_PASSWORD;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        register.mutate();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="register-username">Username</Label>

        <Input
          aria-invalid={username.trim() !== "" && !usernameValid}
          autoComplete="username"
          id="register-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />

        {username.trim() !== "" && !usernameValid && (
          <p className="text-xs text-destructive">
            A username is 3 to 32 letters, numbers, underscores or hyphens.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="register-email">Recovery email</Label>

        <Input
          aria-invalid={email.trim() !== "" && !emailValid}
          autoComplete="email"
          id="register-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <p className="text-xs text-muted-foreground">
          For recovering the account later.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="register-password">Password</Label>

        <Input
          aria-invalid={password !== "" && !passwordValid}
          autoComplete="new-password"
          id="register-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {password !== "" && !passwordValid && (
          <p className="text-xs text-destructive">
            A password is 8 to 128 characters.
          </p>
        )}
      </div>

      <Button
        className="w-full"
        disabled={
          !usernameValid || !emailValid || !passwordValid || register.isPending
        }
        size="lg"
        type="submit"
      >
        {register.isPending ? "Registering…" : "Register"}
      </Button>
    </form>
  );
}
