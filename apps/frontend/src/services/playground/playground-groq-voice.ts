import type { PlaygroundGroqTurnOptions } from "./index";
import type {
  PlaygroundVoiceCall,
  PlaygroundVoiceStartOptions,
} from "./playground-voice";
import type { PlaygroundVoiceTranscript } from "./playground-voice-events";
import {
  PlaygroundVoiceActivity,
  voiceSampleLevel,
  VOICE_ACTIVITY_THRESHOLD,
} from "./playground-voice-audio";

import playgroundLocalSttService, {
  type PlaygroundLocalStt,
} from "./playground-local-stt";
import PlaygroundGroqPlayback from "./playground-groq-playback";

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

async function start(
  options: PlaygroundVoiceStartOptions,
): Promise<PlaygroundVoiceCall> {
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof AudioContext === "undefined" ||
    typeof AudioWorkletNode === "undefined"
  )
    throw new Error(
      "Groq Call needs microphone access in a browser supporting AudioWorklet on HTTPS.",
    );
  const sendTurn = options.sendTurn;
  if (!sendTurn)
    throw new Error(
      "Groq Call is unavailable. Reload Playground and try again.",
    );
  options.signal.throwIfAborted();
  const context = new AudioContext({ sampleRate: 16000 });
  const recordingOutput = options.onAudioSources
    ? context.createMediaStreamDestination()
    : null;
  const controller = new AbortController();
  const activity = new PlaygroundVoiceActivity();
  let microphone: MediaStream | null = null;
  let cameraStream: MediaStream | null = null;
  let capture: AudioWorkletNode | null = null;
  let input: MediaStreamAudioSourceNode | null = null;
  let closed = false;
  let closing: Promise<void> | undefined;
  let muted = options.voiceEnabled === false;
  let activeTurn: AbortController | null = null;
  let activeUserId: number | null = null;
  let speechFrames = 0;
  let inputActive = false;
  let cameraVersion = 0;
  let transcripts: PlaygroundVoiceTranscript[] = [];
  let nextTranscriptId = 0;
  let inputId: number | null = null;
  let previewFrames = 0;
  let preview: AbortController | null = null;
  let recognizer: PlaygroundLocalStt | null = null;
  let recognizingFinal = false;

  function updateTranscript(
    id: number,
    role: "user" | "assistant",
    text: string,
    complete: boolean,
  ) {
    const entry = { id, role, text, complete };
    transcripts = transcripts.some((item) => item.id === id)
      ? transcripts.map((item) => (item.id === id ? entry : item))
      : [...transcripts, entry];
    options.onTranscripts(transcripts);
  }

  function removeDraft(id: number | null) {
    if (
      id === null ||
      !transcripts.some((entry) => entry.id === id && !entry.complete)
    )
      return;
    transcripts = transcripts.filter(
      (entry) => entry.id !== id || entry.complete,
    );
    options.onTranscripts(transcripts);
  }

  function cancelPreview() {
    preview?.abort();
    preview = null;
  }

  function discardInput() {
    cancelPreview();
    removeDraft(inputId);
    inputId = null;
    previewFrames = 0;
    activity.reset();
    updateInputActivity();
  }

  async function transcribe(id: number) {
    if (!recognizer || preview) return;
    const request = new AbortController();
    preview = request;
    previewFrames = 0;
    const current = () =>
      !closed &&
      !muted &&
      inputId === id &&
      preview === request &&
      !request.signal.aborted;
    try {
      const previousLength =
        transcripts.find((entry) => entry.id === id)?.text.length ?? 0;
      const text = await recognizer.transcribe(activity.snapshot(), {
        signal: request.signal,
        onText: (text) => {
          if (
            current() &&
            text.length >= previousLength &&
            /[\p{L}\p{N}]/u.test(text)
          )
            updateTranscript(id, "user", text, false);
        },
      });
      if (!current()) return;
      if (/[\p{L}\p{N}]/u.test(text)) updateTranscript(id, "user", text, false);
      else removeDraft(id);
    } catch (error) {
      if (current())
        void finish(
          error instanceof Error
            ? error.message
            : "Live transcription failed. Start a new call to retry.",
        );
    } finally {
      if (preview === request) preview = null;
    }
  }

  function updateInputActivity() {
    if (inputActive === activity.active) return;
    inputActive = activity.active;
    options.onInputActive?.(inputActive);
  }

  function interrupt() {
    activeTurn?.abort();
    activeTurn = null;
    recognizingFinal = false;
    removeDraft(activeUserId);
    activeUserId = null;
  }

  function history(): PlaygroundGroqTurnOptions["messages"] {
    // Include only text already visible to the user, even after an interruption.
    const messages = transcripts
      .filter(
        (entry) =>
          entry.text.trim() && (entry.role === "assistant" || entry.complete),
      )
      .slice(-20)
      .map((entry) => ({ role: entry.role, content: entry.text }));
    while (
      new TextEncoder().encode(
        messages.map((message) => message.content).join(""),
      ).length > 32000
    )
      messages.splice(0, 2);
    return messages;
  }

  function finish(message?: string) {
    if (closed) return closing;
    closed = true;
    options.onBeforeEnd?.();
    cameraVersion += 1;
    controller.abort();
    recognizer?.dispose();
    interrupt();
    discardInput();
    options.signal.removeEventListener("abort", end);
    stopStream(microphone);
    stopStream(cameraStream);
    stopStream(recordingOutput?.stream ?? null);
    capture?.port.close();
    capture?.disconnect();
    input?.disconnect();
    options.onCamera(null);
    options.onInputLevel?.(0);
    options.onStatus(message ? "failed" : "ending");
    closing = context
      .close()
      .catch(() => undefined)
      .then(() => {
        if (!message) options.onStatus("ended");
      });
    if (message) options.onError(message);
    return closing;
  }
  const end = () => {
    void finish();
  };
  options.signal.addEventListener("abort", end, { once: true });

  const call: PlaygroundVoiceCall = {
    end: () => finish(),
    mute(value) {
      muted = value;
      if (muted) {
        options.onInputLevel?.(0);
        if (recognizingFinal) {
          interrupt();
          options.onPhase?.("listening");
        }
      }
      discardInput();
      speechFrames = 0;
      microphone?.getAudioTracks().forEach((track) => {
        track.enabled = !value;
      });
    },
    async camera(enabled) {
      const version = ++cameraVersion;
      stopStream(cameraStream);
      cameraStream = null;
      options.onCamera(null);
      options.onCameraError(null);
      if (!enabled || closed) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
        if (closed || version !== cameraVersion) {
          stopStream(stream);
          return;
        }
        cameraStream = stream;
        stream.getVideoTracks().forEach((track) => {
          track.onended = () => {
            if (closed || version !== cameraVersion) return;
            stopStream(cameraStream);
            cameraStream = null;
            options.onCamera(null);
            options.onCameraError(
              "Camera access ended. You can keep talking without it.",
            );
          };
        });
        options.onCamera(stream);
      } catch {
        if (!closed && version === cameraVersion)
          options.onCameraError(
            "Camera unavailable. You can keep talking without it.",
          );
      }
    },
  };

  async function turn(samples: Float32Array, userId: number) {
    interrupt();
    const request = new AbortController();
    activeTurn = request;
    activeUserId = userId;
    const current = () =>
      !closed && activeTurn === request && !request.signal.aborted;
    let sawEvent = false;
    let reply = "";
    const playback = new PlaygroundGroqPlayback({
      context,
      recordingOutput,
      signal: request.signal,
      onPhase: (phase) => {
        if (current()) options.onPhase?.(phase);
      },
      onError: fail,
    });
    options.onPhase?.("transcribing");

    function update(
      id: number,
      role: "user" | "assistant",
      text: string,
      complete: boolean,
    ) {
      if (!current()) return;
      updateTranscript(id, role, text, complete);
    }

    function fail(error: unknown) {
      if (current())
        void finish(
          error instanceof Error
            ? error.message
            : "Groq Call failed. Start a new call to retry.",
        );
    }

    const onEvent: NonNullable<PlaygroundGroqTurnOptions["onEvent"]> = (
      event,
    ) => {
      if (!current()) return;
      sawEvent = true;
      if (event.type === "transcript") update(userId, "user", event.text, true);
      if (event.type === "delta") {
        reply += event.text;
        update(userId + 1, "assistant", reply, false);
      }
      if (event.type === "done") {
        update(userId + 1, "assistant", reply, true);
        void playback.complete();
      }
      if (event.type === "audio") playback.append(event.audio);
    };

    try {
      recognizingFinal = true;
      const previousLength =
        transcripts.find((entry) => entry.id === userId)?.text.length ?? 0;
      const text = (
        await recognizer!.transcribe(samples, {
          signal: request.signal,
          onText: (text) => {
            if (text.length >= previousLength && /[\p{L}\p{N}]/u.test(text))
              update(userId, "user", text, false);
          },
        })
      ).trim();
      if (!current()) return;
      recognizingFinal = false;
      if (!/[\p{L}\p{N}]/u.test(text)) {
        removeDraft(userId);
        activeTurn = null;
        activeUserId = null;
        options.onPhase?.("listening");
        return;
      }
      if (new TextEncoder().encode(text).length > 8000)
        throw new Error(
          "This transcript is too long. Start a new call and use shorter sentences.",
        );
      const messages = history();
      update(userId, "user", text, true);
      options.onPhase?.("thinking");
      const result = await sendTurn!({
        connectionId: options.connectionId,
        organizationId: options.organizationId,
        model: options.model,
        transcript: text,
        messages,
        signal: request.signal,
        onEvent,
      });
      if (!current()) return;
      if (!result) removeDraft(userId);
      if (result && !sawEvent) {
        onEvent({ type: "transcript", text: result.transcript });
        onEvent({ type: "delta", text: result.reply });
        for (const audio of result.audio) onEvent({ type: "audio", audio });
        onEvent({ type: "done" });
      }
      await playback.complete();
      if (current()) {
        activeTurn = null;
        activeUserId = null;
        options.onPhase?.("listening");
      }
    } catch (error) {
      fail(error);
    } finally {
      playback.stop();
    }
  }

  options.onStatus("connecting");
  try {
    await context.resume();
    await context.audioWorklet.addModule(
      `${import.meta.env.BASE_URL}audio/groq-capture.js`,
    );
    controller.signal.throwIfAborted();
    recognizer = await playgroundLocalSttService.start({
      signal: controller.signal,
      onLoading: options.onLoading,
    });
    controller.signal.throwIfAborted();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    if (closed) {
      stopStream(stream);
      controller.signal.throwIfAborted();
    }
    microphone = stream;
    options.onAudioSources?.({
      microphone,
      bot: recordingOutput?.stream ?? null,
    });
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
      track.onended = () =>
        finish("Microphone access ended. Start a new call to reconnect.");
    });
    input = context.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(context, "groq-capture");
    capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (closed || muted) return;
      const level = voiceSampleLevel(event.data);
      options.onInputLevel?.(level);
      speechFrames = level >= VOICE_ACTIVITY_THRESHOLD ? speechFrames + 1 : 0;
      if (speechFrames >= 2 && activeTurn) {
        interrupt();
        options.onPhase?.("listening");
      }
      const samples = activity.push(event.data);
      updateInputActivity();
      if (activity.active && inputId === null) {
        inputId = nextTranscriptId;
        nextTranscriptId += 2;
      }
      if (samples && inputId !== null) {
        const id = inputId;
        inputId = null;
        previewFrames = 0;
        cancelPreview();
        void turn(samples, id);
      } else if (inputId !== null) {
        previewFrames += 1;
        // At most one local decode at a time; no work during silent pauses.
        // Each cumulative result replaces the same provisional YOU row.
        if (previewFrames >= 10 && level >= VOICE_ACTIVITY_THRESHOLD)
          void transcribe(inputId);
      }
    };
    input.connect(capture);
    capture.connect(context.destination); // Processor output is silence; microphone is never played back.
    if (options.cameraEnabled !== false) void call.camera(true);
    options.onStatus("connected");
    options.onPhase?.("listening");
    return call;
  } catch (error) {
    const failure =
      error instanceof DOMException && error.name === "NotAllowedError"
        ? new Error(
            "Allow microphone access in your browser to start a call.",
            { cause: error },
          )
        : error;
    if (!closed)
      finish(
        failure instanceof Error
          ? failure.message
          : "The call could not start.",
      );
    throw failure;
  }
}

const playgroundGroqVoiceService = { start };
export default playgroundGroqVoiceService;
