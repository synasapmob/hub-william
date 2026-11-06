import { useEffect, useRef } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { useSearchParams } from "react-router";

import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";

import type { PlaygroundAttachment } from "@/services/playground/playground-types";
import { playgroundModes } from "@/services/provider-catalogue/provider-catalogue-service";
import playgroundMedia, {
  type SavedPlaygroundMode,
} from "@/utils/utils.playground-media";

import PlaygroundWorkspace from "./playground-workspace";

// Whose accounts a chat uses: the user's own, an organization's, or the
// platform's, which are paid for.
export type PlaygroundKind = "workspace" | "organization" | "service";

export interface PlaygroundFormValues {
  attachments: PlaygroundAttachment[];
  connectionId: string;
  kind: PlaygroundKind;
  organizationId: string;
  provider: string;
  model: string;
  mode: SavedPlaygroundMode;
  prompt: string;
}

export default function PlaygroundRoute() {
  const session = useWorkspaceSession();
  const [searchParams] = useSearchParams();
  const organizationFromUrl = searchParams.get("organization") ?? "";
  const kindFromUrl: PlaygroundKind =
    searchParams.get("kind") === "service"
      ? "service"
      : organizationFromUrl
        ? "organization"
        : "workspace";
  const connectionFromUrl = searchParams.get("connection") ?? "";
  const providerFromUrl = searchParams.get("provider") ?? "chatgpt";
  const schema = z.object({
    connectionId: z.string(),
    kind: z.enum(["workspace", "organization", "service"]),
    organizationId: z.string(),
    provider: z.string(),
    model: z.string(),
    mode: z.enum([...playgroundModes, "voice"]),
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
      connectionId: connectionFromUrl,
      kind: kindFromUrl,
      organizationId: organizationFromUrl,
      provider: providerFromUrl,
      model: "",
      mode: "chat",
      prompt: "",
    },
  });
  const organizationId = useWatch({
    control: form.control,
    name: "organizationId",
  });
  const kind = useWatch({ control: form.control, name: "kind" });

  const previousUserId = useRef(session.user?.id);
  const { reset } = form;
  useEffect(() => {
    form.setValue("mode", playgroundMedia.readMode());
  }, [form]);
  useEffect(() => {
    form.setValue("kind", kindFromUrl);
    form.setValue("organizationId", organizationFromUrl);
    form.setValue("connectionId", connectionFromUrl);
    form.setValue("provider", providerFromUrl);
    form.setValue("model", "");
  }, [
    connectionFromUrl,
    form,
    kindFromUrl,
    organizationFromUrl,
    providerFromUrl,
  ]);
  useEffect(() => {
    if (previousUserId.current && previousUserId.current !== session.user?.id) {
      reset();
      form.setValue("mode", playgroundMedia.readMode());
    }
    previousUserId.current = session.user?.id;
  }, [form, reset, session.user?.id]);

  return (
    <section className="mx-auto w-full max-w-400 space-y-5 px-4 pt-6 pb-4 sm:px-6 lg:px-8 lg:pt-8">
      <header className="space-y-3">
        <h1 className="font-heading text-3xl font-bold tracking-tight">
          Playground
        </h1>

        <p className="text-sm text-muted-foreground">
          Choose a kind, then Chat, Call Live or Call Whisper, an account and a
          model. A Service chat is paid for from your balance and has Chat only.
        </p>
      </header>

      <PlaygroundWorkspace
        key={`${session.user?.id ?? "guest"}:${kind}:${organizationId}`}
        form={form}
      />
    </section>
  );
}
