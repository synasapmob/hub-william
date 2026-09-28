import playgroundService, { type PlaygroundProviderId } from "./index";
import type {
  PlaygroundLocalTts,
  PlaygroundSpeechAudio,
} from "./playground-local-tts";

export interface PlaygroundWhisperMessage {
  role: "user" | "assistant";
  content: string;
}

export type PlaygroundWhisperEvent =
  | { type: "transcript" | "delta"; text: string }
  | { type: "audio"; audio: PlaygroundSpeechAudio | string }
  | { type: "done" };

export interface PlaygroundWhisperTurnOptions {
  provider: PlaygroundProviderId;
  connectionId: string;
  organizationId?: string;
  model: string;
  transcript: string;
  messages: PlaygroundWhisperMessage[];
  signal: AbortSignal;
  speech: PlaygroundLocalTts;
  onEvent?: (event: PlaygroundWhisperEvent) => void;
}

export interface PlaygroundWhisperTurnResult {
  transcript: string;
  reply: string;
  audio: (PlaygroundSpeechAudio | string)[];
}

/** One text generation; local speech follows complete, bounded text segments. */
async function turn(
  options: PlaygroundWhisperTurnOptions,
): Promise<PlaygroundWhisperTurnResult> {
  const { signal, onEvent } = options;
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let reply = "";
  let pending = "";
  let speech = Promise.resolve();
  let failure: unknown;
  const emit = (event: PlaygroundWhisperEvent) => {
    if (!controller.signal.aborted) onEvent?.(event);
  };
  function enqueue(text: string) {
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    speech = speech
      .then(async () => {
        controller.signal.throwIfAborted();
        const audio = await options.speech.synthesize(text, controller.signal);
        emit({ type: "audio", audio });
      })
      .catch((error: unknown) => {
        failure ??= error;
        controller.abort();
      });
  }
  function flush(final = false) {
    while (pending.trim()) {
      const boundary = /[.!?。！？](?:\s|$)|\n/.exec(pending);
      let end = boundary ? boundary.index + boundary[0].length : 0;
      if (end > 240 || (!end && pending.length >= 240))
        end =
          pending.lastIndexOf(" ", 240) > 0
            ? pending.lastIndexOf(" ", 240)
            : 240;
      if (!end && !final) return;
      end ||= pending.length;
      enqueue(pending.slice(0, end).trim());
      pending = pending.slice(end);
    }
  }
  try {
    emit({ type: "transcript", text: options.transcript });
    await playgroundService.chat({
      provider: options.provider,
      connectionId: options.connectionId,
      organizationId: options.organizationId,
      model: options.model,
      messages: [
        ...options.messages,
        { role: "user", content: options.transcript },
      ],
      signal: controller.signal,
      onDelta: (text) => {
        controller.signal.throwIfAborted();
        reply += text;
        if (reply.length > 16000)
          throw new Error(
            "This spoken reply is too long. Ask for a shorter answer.",
          );
        emit({ type: "delta", text });
        pending += text;
        flush();
      },
    });
    flush(true);
    await speech;
    if (failure) throw failure;
    controller.signal.throwIfAborted();
    emit({ type: "done" });
    // PCM is consumed as it arrives; mutation state must not retain it again.
    return { transcript: options.transcript, reply, audio: [] };
  } catch (error) {
    const cause = failure ?? error;
    controller.abort();
    await speech;
    throw cause;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export default { turn };
