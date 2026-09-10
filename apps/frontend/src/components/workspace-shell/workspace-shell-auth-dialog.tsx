import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import Center from "@/components/ui/center";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuthServiceError } from "@/services/auth";
import type { LoginCredentials, RegisterCredentials } from "@/services/auth";

export type WorkspaceShellAuthMode = "login" | "register";

interface AuthFormValues {
  password: string;
  recoveryEmail: string;
  username: string;
}

interface WorkspaceShellAuthDialogProps {
  onAuthenticate: (
    mode: WorkspaceShellAuthMode,
    credentials: LoginCredentials | RegisterCredentials,
  ) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export default function WorkspaceShellAuthDialog({
  onAuthenticate,
  onOpenChange,
  open,
}: WorkspaceShellAuthDialogProps) {
  const [mode, setMode] = useState<WorkspaceShellAuthMode>("login");
  const authSchema = z
    .object({
      password: z.string().min(8, "Use at least 8 characters."),
      recoveryEmail: z.union([
        z.literal(""),
        z.email("Enter a valid recovery email."),
      ]),
      username: z
        .string()
        .trim()
        .min(3, "Use at least 3 characters.")
        .max(32, "Use no more than 32 characters.")
        .regex(
          /^[a-zA-Z0-9_-]+$/,
          "Use letters, numbers, underscores, or hyphens.",
        ),
    })
    .superRefine((values, context) => {
      if (mode === "register" && !values.recoveryEmail) {
        context.addIssue({
          code: "custom",
          message: "Add an email for future account recovery.",
          path: ["recoveryEmail"],
        });
      }
    });
  const form = useForm<AuthFormValues>({
    defaultValues: { password: "", recoveryEmail: "", username: "" },
    resolver: zodResolver(authSchema),
  });

  function changeMode(value: string) {
    if (value !== "login" && value !== "register") return;
    setMode(value);
    form.clearErrors();
  }

  async function submit(values: AuthFormValues) {
    try {
      await onAuthenticate(
        mode,
        mode === "login"
          ? { password: values.password, username: values.username }
          : {
              password: values.password,
              recoveryEmail: values.recoveryEmail,
              username: values.username,
            },
      );
      form.reset();
    } catch (error) {
      form.setError("root", {
        message:
          error instanceof AuthServiceError
            ? error.message
            : "Authentication failed.",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader className="items-center text-center">
          <Center className="mb-1 size-10 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-600">
            <KeyRound aria-hidden="true" className="size-5" />
          </Center>

          <DialogTitle>Join the sharing community</DialogTitle>
          <DialogDescription>
            Browsing stays public. An account is only required when you request
            access to a pool.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={changeMode}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">Login</TabsTrigger>
            <TabsTrigger value="register">Register</TabsTrigger>
          </TabsList>
        </Tabs>

        <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
          <div className="space-y-1.5">
            <Label htmlFor="auth-username">Username</Label>
            <Input
              id="auth-username"
              autoComplete="username"
              placeholder="Enter your username"
              aria-invalid={Boolean(form.formState.errors.username)}
              {...form.register("username")}
            />
            {form.formState.errors.username ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.username.message}
              </p>
            ) : null}
          </div>

          {mode === "register" ? (
            <div className="space-y-1.5">
              <Label htmlFor="auth-recovery-email">Recovery email</Label>
              <Input
                id="auth-recovery-email"
                type="email"
                autoComplete="email"
                placeholder="example@gmail.com"
                aria-invalid={Boolean(form.formState.errors.recoveryEmail)}
                {...form.register("recoveryEmail")}
              />

              {form.formState.errors.recoveryEmail ? (
                <p className="text-xs text-destructive">
                  {form.formState.errors.recoveryEmail.message}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="auth-password">Password</Label>
            <Input
              id="auth-password"
              type="password"
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              placeholder="Enter your password"
              aria-invalid={Boolean(form.formState.errors.password)}
              {...form.register("password")}
            />
            {form.formState.errors.password ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.password.message}
              </p>
            ) : null}
          </div>

          {form.formState.errors.root ? (
            <p className="rounded-lg bg-red-50 p-2.5 text-xs text-destructive">
              {form.formState.errors.root.message}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting
                ? "Please wait…"
                : mode === "login"
                  ? "Login"
                  : "Create account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
