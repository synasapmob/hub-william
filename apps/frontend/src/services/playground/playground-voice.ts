import providerCatalogue from "@/services/provider-catalogue";
import type { CatalogueCallProfile } from "@/services/provider-catalogue.generated";
import playgroundService, { type PlaygroundVoiceSessionOptions } from "./index";
import type {
  PlaygroundWhisperTurnOptions,
  PlaygroundWhisperTurnResult,
} from "./playground-whisper-turn";
import playgroundWhisperVoiceService from "./playground-whisper-voice";
import PlaygroundVoiceMeter from "./playground-voice-meter";
import {
  appendVoiceTranscript,
  readVoiceEvent,
  type PlaygroundVoiceTranscript,
} from "./playground-voice-events";

export type PlaygroundVoiceStatus =
  "idle" | "connecting" | "connected" | "ending" | "ended" | "failed";

export interface PlaygroundVoiceCall {
  end: () => void | Promise<void>;
  mute: (muted: boolean) => void;
  camera: (enabled: boolean) => Promise<void>;
}

export interface PlaygroundVoiceAudioSources {
  microphone: MediaStream;
  bot: MediaStream | null;
}

export interface PlaygroundVoiceStartOptions extends Omit<
  PlaygroundVoiceSessionOptions,
  "sdp"
> {
  callProfile?: CatalogueCallProfile;
  mode?: "call-live" | "call-whisper";
  voiceEnabled?: boolean;
  cameraEnabled?: boolean;
  onStatus: (status: PlaygroundVoiceStatus) => void;
  onAudioSources?: (sources: PlaygroundVoiceAudioSources) => void;
  onBeforeEnd?: () => void;
  onTranscripts: (entries: PlaygroundVoiceTranscript[]) => void;
  onRemoteAudio: (stream: MediaStream) => void;
  onCamera: (stream: MediaStream | null) => void;
  onCameraError: (message: string | null) => void;
  onError: (message: string) => void;
  onLoading?: (message: string | null) => void;
  onPhase?: (
    phase: "listening" | "transcribing" | "thinking" | "speaking",
  ) => void;
  onInputLevel?: (level: number) => void;
  onInputActive?: (active: boolean) => void;
  onOutputLevel?: (level: number) => void;
  sendTurn?: (
    options: PlaygroundWhisperTurnOptions,
  ) => Promise<PlaygroundWhisperTurnResult | null>;
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function mediaError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError")
      return "Allow microphone access in your browser to start a call.";
    if (error.name === "NotFoundError")
      return "No microphone was found. Connect one and try again.";
    if (error.name === "NotReadableError")
      return "Your microphone is busy or unavailable. Check it and try again.";
  }
  return error instanceof Error
    ? error.message
    : "The voice call could not start.";
}

async function start(
  options: PlaygroundVoiceStartOptions,
): Promise<PlaygroundVoiceCall> {
  if (options.mode === "call-whisper") {
    if (
      !providerCatalogue.supportsMode(options.provider, "call-whisper") ||
      !options.model
    )
      throw new Error("Choose an available chat model for Call Whisper.");
    return playgroundWhisperVoiceService.start(options);
  }
  const profile =
    options.callProfile ??
    providerCatalogue.callProfile(options.provider, options.model);
  if (
    !profile ||
    profile.provider !== options.provider ||
    profile.selector_model !== options.model ||
    profile.kind !== "native_realtime" ||
    profile.transport !== "codex_v3_webrtc"
  )
    throw new Error("Choose an available call model.");
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof RTCPeerConnection === "undefined"
  )
    throw new Error(
      "Voice needs a browser with microphone access on HTTPS or localhost.",
    );
  const { signal } = options;
  signal.throwIfAborted();
  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel("oai-events");
  let microphone: MediaStream | null = null;
  let cameraStream: MediaStream | null = null;
  let remoteStream: MediaStream | null = null;
  let entries: PlaygroundVoiceTranscript[] = [];
  let closed = false;
  let cameraVersion = 0;
  let connected = false;
  let failure: string | undefined;
  let muted = options.voiceEnabled === false;
  let meter: PlaygroundVoiceMeter | null = null;
  let closing: Promise<void> | undefined;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Permission/SDP work can fail before this promise is awaited.
  void ready.catch(() => undefined);

  const finish = (status: PlaygroundVoiceStatus, message?: string) => {
    if (closed) return closing;
    closed = true;
    options.onBeforeEnd?.();
    failure = message;
    cameraVersion += 1;
    signal.removeEventListener("abort", abort);
    window.clearTimeout(timeout);
    rejectReady(
      message
        ? new Error(message)
        : new DOMException("Call ended", "AbortError"),
    );
    channel.close();
    peer.close();
    stopStream(microphone);
    stopStream(cameraStream);
    stopStream(remoteStream);
    options.onCamera(null);
    options.onInputLevel?.(0);
    options.onOutputLevel?.(0);
    if (meter) {
      options.onStatus(status === "ended" ? "ending" : status);
      closing = meter
        .end()
        .catch(() => undefined)
        .then(() => {
          if (status === "ended") options.onStatus("ended");
        });
    } else options.onStatus(status);
    if (message) options.onError(message);
    return closing;
  };
  const abort = () => {
    void finish("ended");
  };
  const timeout = window.setTimeout(() => {
    if (!connected)
      finish(
        "failed",
        "The voice connection timed out. Start a new call to retry.",
      );
  }, 50_000);
  signal.addEventListener("abort", abort, { once: true });

  const call: PlaygroundVoiceCall = {
    end: () => finish("ended"),
    mute: (value) => {
      muted = value;
      if (muted) options.onInputLevel?.(0);
      microphone?.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    },
    camera: async (enabled) => {
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
            cameraVersion += 1;
            stopStream(cameraStream);
            cameraStream = null;
            options.onCamera(null);
            options.onCameraError(
              "Camera access ended. You can keep talking without it.",
            );
          };
        });
        // Deliberately never add camera tracks to the peer: camera is a local
        // preview until native video perception is verified for this model.
        options.onCamera(stream);
      } catch {
        if (!closed && version === cameraVersion)
          options.onCameraError(
            "Camera unavailable. You can keep talking without it.",
          );
      }
    },
  };

  channel.onopen = () => {
    if (closed) return;
    connected = true;
    window.clearTimeout(timeout);
    options.onStatus("connected");
    resolveReady();
  };
  channel.onclose = () => {
    if (!closed)
      finish(
        "failed",
        "The voice connection closed. Start a new call to reconnect.",
      );
  };
  channel.onerror = () =>
    finish("failed", "The voice connection failed. Start a new call to retry.");
  channel.onmessage = (message) => {
    if (closed) return;
    const event = readVoiceEvent(message.data);
    if (event?.type === "transcript") {
      entries = appendVoiceTranscript(entries, event);
      options.onTranscripts(entries);
    } else if (event?.type === "error") finish("failed", event.message);
  };
  peer.onconnectionstatechange = () => {
    if (
      peer.connectionState === "failed" ||
      peer.connectionState === "disconnected"
    )
      finish(
        "failed",
        "The call was disconnected. Start a new call to reconnect.",
      );
  };
  peer.ontrack = (event) => {
    if (closed || event.track.kind !== "audio") return;
    remoteStream = event.streams[0] ?? new MediaStream([event.track]);
    if (options.onOutputLevel)
      meter?.observe(remoteStream, options.onOutputLevel);
    options.onRemoteAudio(remoteStream);
    if (microphone) options.onAudioSources?.({ microphone, bot: remoteStream });
  };

  options.onStatus("connecting");
  try {
    if (options.onInputLevel || options.onOutputLevel) {
      meter = new PlaygroundVoiceMeter();
      await meter.resume();
      if (closed) throw new DOMException("Call ended", "AbortError");
    }
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
      throw new DOMException("Call ended", "AbortError");
    }
    microphone = stream;
    options.onAudioSources?.({ microphone, bot: remoteStream });
    if (options.onInputLevel)
      meter?.observe(stream, (level) =>
        options.onInputLevel?.(muted ? 0 : level),
      );
    microphone.getAudioTracks().forEach((track) => {
      track.onended = () =>
        finish(
          "failed",
          "Microphone access ended. Start a new call to reconnect.",
        );
      track.enabled = !muted;
      peer.addTrack(track, stream);
    });
    if (options.cameraEnabled !== false) void call.camera(true);
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer, signal);
    if (closed) throw new DOMException("Call ended", "AbortError");
    const sdp = peer.localDescription?.sdp;
    if (!sdp)
      throw new Error("Your browser could not prepare the voice connection.");
    const answer = await playgroundService.voiceSession({
      connectionId: options.connectionId,
      organizationId: options.organizationId,
      provider: options.provider,
      model: options.model,
      signal,
      sdp,
    });
    if (closed) throw new DOMException("Call ended", "AbortError");
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
    await ready;
    return call;
  } catch (error) {
    if (!closed) finish(signal.aborted ? "ended" : "failed");
    if (signal.aborted) throw error;
    throw new Error(failure ?? mediaError(error), { cause: error });
  }
}

function waitForIce(
  peer: RTCPeerConnection,
  signal: AbortSignal,
): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
      signal.removeEventListener("abort", aborted);
    };
    const changed = () => {
      if (peer.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };
    const aborted = () => {
      cleanup();
      reject(new DOMException("Call ended", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 3_000);
    peer.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

const playgroundVoiceService = { start };
export default playgroundVoiceService;
