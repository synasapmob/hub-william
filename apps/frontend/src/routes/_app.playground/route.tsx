import { useEffect, useRef } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";

import type { PlaygroundAttachment } from "@/services/playground";

import PlaygroundWorkspace from "./playground-workspace";

export interface PlaygroundFormValues {
  attachments: PlaygroundAttachment[];
  connectionId: string;
  provider: string;
  model: string;
  prompt: string;
}

export default function PlaygroundRoute() {
  const session = useWorkspaceSession();
  const schema = z.object({
    connectionId: z.string(),
    provider: z.string(),
    model: z.string(),
    prompt: z.string().trim(),
    attachments: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("text"),
            name: z.string(),
            text: z.string(),
          }),
          z.object({
            kind: z.literal("image"),
            name: z.string(),
            media_type: z.string(),
            data: z.string(),
          }),
        ]),
      )
      .max(4, "Attach up to 4 files per message."),
  });
  const form = useForm<PlaygroundFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      attachments: [],
      connectionId: "",
      provider: "chatgpt",
      model: "",
      prompt: "",
    },
  });

  const previousUserId = useRef(session.user?.id);
  const { reset } = form;
  useEffect(() => {
    if (previousUserId.current && previousUserId.current !== session.user?.id)
      reset();
    previousUserId.current = session.user?.id;
  }, [reset, session.user?.id]);

  return (
    <section className="mx-auto w-full max-w-400 space-y-5 px-4 pt-6 pb-4 sm:px-6 lg:px-8 lg:pt-8">
      <header className="space-y-3">
        <h1 className="font-heading text-3xl font-bold tracking-tight">
          Playground
        </h1>

        <p className="text-sm text-muted-foreground">
          Choose a model, send a message and read its response here.
        </p>
      </header>

      <PlaygroundWorkspace key={session.user?.id ?? "guest"} form={form} />
    </section>
  );
}
