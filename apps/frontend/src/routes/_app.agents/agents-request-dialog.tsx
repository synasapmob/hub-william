import { zodResolver } from "@hookform/resolvers/zod";
import { Send } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import type { AgentPool } from "@/services/agent-pools";

interface RequestFormValues {
  reason: string;
  telegram: string;
}

interface AgentsRequestDialogProps {
  onOpenChange: (open: boolean) => void;
  onSubmitRequest: (values: RequestFormValues) => Promise<void>;
  open: boolean;
  pool: AgentPool | null;
}

export default function AgentsRequestDialog({
  onOpenChange,
  onSubmitRequest,
  open,
  pool,
}: AgentsRequestDialogProps) {
  const requestSchema = z.object({
    reason: z.string().trim().min(10, "Tell the owner a little more."),
    telegram: z
      .string()
      .trim()
      .regex(/^@[a-zA-Z0-9_]{3,32}$/, "Use a Telegram username like @william."),
  });
  const form = useForm<RequestFormValues>({
    defaultValues: { reason: "", telegram: "" },
    resolver: zodResolver(requestSchema),
  });

  function changeOpen(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) form.reset();
  }

  async function submit(values: RequestFormValues) {
    try {
      await onSubmitRequest(values);
      form.reset();
    } catch (error) {
      form.setError("root", {
        message:
          error instanceof Error
            ? error.message
            : "The join request could not be sent.",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <Center className="mb-1 size-10 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-600">
            <Send aria-hidden="true" className="size-5" />
          </Center>

          <DialogTitle>
            Request to join {pool?.owner.username}'s pool
          </DialogTitle>
          <DialogDescription>
            Introduce yourself and leave a Telegram username so the owner can
            coordinate sharing with you directly.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
          <div className="space-y-1.5">
            <Label htmlFor="request-telegram">Telegram username</Label>
            <Input
              id="request-telegram"
              placeholder="@yourusername"
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.telegram)}
              {...form.register("telegram")}
            />
            {form.formState.errors.telegram ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.telegram.message}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="request-reason">Why do you want to join?</Label>
            <Textarea
              id="request-reason"
              rows={4}
              placeholder="Share how you use this agent and when you are usually active."
              aria-invalid={Boolean(form.formState.errors.reason)}
              {...form.register("reason")}
            />
            {form.formState.errors.reason ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.reason.message}
              </p>
            ) : null}
          </div>

          <p className="rounded-lg bg-zinc-50 p-2.5 text-xs/relaxed text-muted-foreground">
            Hub William only lists sharing availability. Any bill splitting or
            payment conversation happens directly on Telegram.
          </p>

          {form.formState.errors.root ? (
            <p className="text-sm text-destructive">
              {form.formState.errors.root.message}
            </p>
          ) : null}

          <DialogFooter>
            <Button disabled={form.formState.isSubmitting} type="submit">
              {form.formState.isSubmitting ? "Sending…" : "Send request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type { RequestFormValues };
