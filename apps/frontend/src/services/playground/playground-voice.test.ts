import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import playgroundService from "./index";
import playgroundVoiceService, {
  type PlaygroundVoiceStartOptions,
} from "./playground-voice";

class FakeChannel {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
}
class FakePeer extends EventTarget {
  static latest: FakePeer;
  channel = new FakeChannel();
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription = {
    type: "offer",
    sdp: "v=0\r\nm=audio 9 RTP/SAVPF 111\r\n",
  };
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  constructor() {
    super();
    FakePeer.latest = this;
  }
  createDataChannel = vi.fn(() => this.channel);
  addTrack = vi.fn();
  createOffer = vi.fn(async () => this.localDescription);
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => {
    this.connectionState = "connected";
    this.channel.onopen?.();
  });
  close = vi.fn();
}
function mediaStream(kind: "audio" | "video") {
  const track = {
    kind,
    stop: vi.fn(),
    enabled: true,
    onended: null as (() => void) | null,
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => (kind === "audio" ? [track] : []),
    getVideoTracks: () => (kind === "video" ? [track] : []),
  } as unknown as MediaStream;
  return { stream, track };
}
function options(signal: AbortSignal): PlaygroundVoiceStartOptions {
  return {
    connectionId: "selected-account",
    provider: "chatgpt",
    model: "gpt-live-1-codex",
    signal,
    onStatus: vi.fn(),
    onTranscripts: vi.fn(),
    onRemoteAudio: vi.fn(),
    onCamera: vi.fn(),
    onCameraError: vi.fn(),
    onError: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.spyOn(playgroundService, "voiceSession").mockResolvedValue(
    "v=0\r\nm=audio 9 RTP/SAVPF 111\r\n",
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Voice media lifecycle", () => {
  it("exposes both native recording sources and stops recording before call media teardown", async () => {
    const microphone = mediaStream("audio");
    const remote = mediaStream("audio");
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(microphone.stream),
      },
    });
    const input = options(new AbortController().signal);
    input.cameraEnabled = false;
    input.onAudioSources = vi.fn();
    input.onBeforeEnd = vi.fn(() => {
      expect(microphone.track.stop).not.toHaveBeenCalled();
      expect(remote.track.stop).not.toHaveBeenCalled();
    });
    const call = await playgroundVoiceService.start(input);
    expect(input.onAudioSources).toHaveBeenLastCalledWith({
      microphone: microphone.stream,
      bot: null,
    });
    FakePeer.latest.ontrack?.({
      track: remote.track,
      streams: [remote.stream],
    } as unknown as RTCTrackEvent);
    expect(input.onAudioSources).toHaveBeenLastCalledWith({
      microphone: microphone.stream,
      bot: remote.stream,
    });
    await call.end();
    expect(input.onBeforeEnd).toHaveBeenCalledOnce();
    expect(microphone.track.stop).toHaveBeenCalledOnce();
    expect(remote.track.stop).toHaveBeenCalledOnce();
  });

  it("starts the native peer muted and skips camera capture when saved choices are off", async () => {
    const microphone = mediaStream("audio");
    const getUserMedia = vi.fn().mockResolvedValue(microphone.stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const input = options(new AbortController().signal);
    input.voiceEnabled = false;
    input.cameraEnabled = false;
    const call = await playgroundVoiceService.start(input);
    expect(microphone.track.enabled).toBe(false);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(FakePeer.latest.addTrack).toHaveBeenCalledWith(
      microphone.track,
      microphone.stream,
    );
    call.mute(false);
    expect(microphone.track.enabled).toBe(true);
    await call.end();
  });

  it("meters native mic and BOT audio separately and awaits meter cleanup on end", async () => {
    vi.useFakeTimers();
    const microphone = mediaStream("audio");
    const remote = mediaStream("audio");
    const camera = mediaStream("video");
    const inputs: MediaStream[] = [];
    let closed!: () => void;
    vi.stubGlobal(
      "AudioContext",
      class {
        resume = async () => undefined;
        close = () =>
          new Promise<void>((resolve) => {
            closed = resolve;
          });
        createMediaStreamSource = (stream: MediaStream) => {
          inputs.push(stream);
          return { connect: vi.fn(), disconnect: vi.fn() };
        };
        createAnalyser = () => ({
          fftSize: 0,
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.05),
          disconnect: vi.fn(),
        });
      },
    );
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(microphone.stream)
          .mockResolvedValueOnce(camera.stream),
      },
    });
    const input = {
      ...options(new AbortController().signal),
      onInputLevel: vi.fn(),
      onOutputLevel: vi.fn(),
    };
    const call = await playgroundVoiceService.start(input);
    FakePeer.latest.ontrack?.({
      track: remote.track,
      streams: [remote.stream],
    } as unknown as RTCTrackEvent);
    vi.advanceTimersByTime(100);
    expect(inputs).toEqual([microphone.stream, remote.stream]);
    expect(input.onInputLevel.mock.lastCall?.[0]).toBeCloseTo(0.05);
    expect(input.onOutputLevel.mock.lastCall?.[0]).toBeCloseTo(0.05);
    call.mute(true);
    vi.advanceTimersByTime(100);
    expect(input.onInputLevel).toHaveBeenLastCalledWith(0);
    expect(input.onOutputLevel.mock.lastCall?.[0]).toBeCloseTo(0.05);
    const ending = call.end();
    expect(input.onStatus).toHaveBeenLastCalledWith("ending");
    expect(microphone.track.stop).toHaveBeenCalledOnce();
    expect(remote.track.stop).toHaveBeenCalledOnce();
    closed();
    await ending;
    expect(input.onStatus).toHaveBeenLastCalledWith("ended");
  });
  it("sends only the microphone, displays native transcripts, and closes all devices on end", async () => {
    const microphone = mediaStream("audio");
    const camera = mediaStream("video");
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(microphone.stream)
      .mockResolvedValueOnce(camera.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const input = options(new AbortController().signal);
    const call = await playgroundVoiceService.start(input);
    const peer = FakePeer.latest;
    expect(peer.addTrack).toHaveBeenCalledExactlyOnceWith(
      microphone.track,
      microphone.stream,
    );
    expect(input.onCamera).toHaveBeenCalledWith(camera.stream);
    peer.channel.onmessage?.(
      new MessageEvent("message", {
        data: '{"type":"input_transcript.added","item":{"text":"Hello"}}',
      }),
    );
    peer.channel.onmessage?.(
      new MessageEvent("message", {
        data: '{"type":"output_transcript.added","item":{"text":"Hi there"}}',
      }),
    );
    expect(
      vi
        .mocked(input.onTranscripts)
        .mock.lastCall?.[0].map((entry) => entry.text),
    ).toEqual(["Hello", "Hi there"]);
    call.mute(true);
    expect(microphone.track.enabled).toBe(false);
    call.mute(false);
    expect(microphone.track.enabled).toBe(true);
    camera.track.onended?.();
    expect(input.onCamera).toHaveBeenLastCalledWith(null);
    expect(input.onCameraError).toHaveBeenCalledWith(
      "Camera access ended. You can keep talking without it.",
    );
    expect(peer.close).not.toHaveBeenCalled();
    call.end();
    expect(microphone.track.stop).toHaveBeenCalledOnce();
    expect(camera.track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(peer.channel.close).toHaveBeenCalledOnce();
  });

  it("releases a late microphone grant when the page was left during the permission prompt", async () => {
    let grant!: (stream: MediaStream) => void;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((resolve) => {
              grant = resolve;
            }),
        ),
      },
    });
    const request = new AbortController();
    const pending = playgroundVoiceService.start(options(request.signal));
    request.abort();
    const microphone = mediaStream("audio");
    grant(microphone.stream);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(microphone.track.stop).toHaveBeenCalledOnce();
    expect(playgroundService.voiceSession).not.toHaveBeenCalled();
    expect(FakePeer.latest.close).toHaveBeenCalledOnce();
  });

  it("continues voice without a camera and cleans up after an unexpected channel closure", async () => {
    const microphone = mediaStream("audio");
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(microphone.stream)
          .mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError")),
      },
    });
    const input = options(new AbortController().signal);
    await playgroundVoiceService.start(input);
    expect(input.onCameraError).toHaveBeenCalledWith(
      "Camera unavailable. You can keep talking without it.",
    );
    FakePeer.latest.channel.onclose?.();
    expect(input.onStatus).toHaveBeenLastCalledWith("failed");
    expect(input.onError).toHaveBeenCalledWith(
      expect.stringContaining("closed"),
    );
    expect(microphone.track.stop).toHaveBeenCalledOnce();
  });
});
