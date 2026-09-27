import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaygroundWhisperTurnResult } from "./playground-whisper-turn";
import type { PlaygroundVoiceStartOptions } from "./playground-voice";
import playgroundWhisperVoiceService from "./playground-whisper-voice";
import type { PlaygroundLocalVadStartOptions } from "./playground-local-vad";

const local = vi.hoisted(() => ({
  transcribe: vi.fn(),
  dispose: vi.fn(),
  start: vi.fn(),
}));
vi.mock("./playground-local-stt", () => ({ default: { start: local.start } }));
const vad = vi.hoisted(() => ({
  start: vi.fn(),
  dispose: vi.fn(),
  reset: vi.fn(),
  probability: null as number | null,
}));
vi.mock("./playground-local-vad", () => ({ default: { start: vad.start } }));

vi.mock("./playground-local-tts", () => ({
  default: {
    start: vi.fn(async () => ({ synthesize: vi.fn(), dispose: vi.fn() })),
  },
}));

const micTrack = { stop: vi.fn(), enabled: true, onended: null };
const cameraTrack = { stop: vi.fn(), onended: null };
const stream = {
  getTracks: () => [micTrack],
  getAudioTracks: () => [micTrack],
};
const camera = {
  getTracks: () => [cameraTrack],
  getVideoTracks: () => [cameraTrack],
};
let autoEnd = true;
let receive: ((event: MessageEvent<Float32Array>) => void) | null;
const closeContext = vi.fn().mockResolvedValue(undefined);
const sourceStop = vi.fn();
const sourceStart = vi.fn();

class TestWorklet {
  port = {
    close: vi.fn(),
    set onmessage(handler: typeof receive) {
      receive = handler;
    },
  };
  connect = vi.fn();
  disconnect = vi.fn();
}
class TestContext {
  destination = {};
  currentTime = 0;
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  resume = vi.fn().mockResolvedValue(undefined);
  close = closeContext;
  decodeAudioData = vi.fn().mockResolvedValue({
    duration: 2,
    length: 32000,
    numberOfChannels: 1,
  });
  createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  createBufferSource = () => {
    const node = {
      buffer: null,
      onended: () => {},
      connect: vi.fn(),
      disconnect: vi.fn(),
      stop: sourceStop,
      start: () => {
        sourceStart();
        if (autoEnd) queueMicrotask(() => node.onended());
      },
    };
    return node;
  };
}
function speak() {
  for (let i = 0; i < 3; i++)
    receive?.({
      data: new Float32Array(1600).fill(0.1),
    } as MessageEvent<Float32Array>);
  for (let i = 0; i < 20; i++)
    receive?.({ data: new Float32Array(1600) } as MessageEvent<Float32Array>);
}
function frames(count: number, level = 0.1) {
  for (let i = 0; i < count; i++)
    receive?.({
      data: new Float32Array(1600).fill(level),
    } as MessageEvent<Float32Array>);
}
function options(): PlaygroundVoiceStartOptions {
  return {
    connectionId: "chosen-account",
    organizationId: "chosen-org",
    provider: "groq",
    model: "openai/gpt-oss-20b",
    signal: new AbortController().signal,
    onStatus: vi.fn(),
    onTranscripts: vi.fn(),
    onRemoteAudio: vi.fn(),
    onCamera: vi.fn(),
    onCameraError: vi.fn(),
    onError: vi.fn(),
    onPhase: vi.fn(),
    onInputLevel: vi.fn(),
    onInputActive: vi.fn(),
    sendTurn: vi.fn().mockResolvedValue({
      transcript: "Hello",
      reply: "How are you?",
      audio: [btoa("wave"), btoa("second")],
    }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  local.transcribe.mockReset().mockResolvedValue("Hello");
  local.start.mockReset().mockResolvedValue(local);
  vad.probability = null;
  vad.start
    .mockReset()
    .mockImplementation(async (options: PlaygroundLocalVadStartOptions) => ({
      push: (audio: Float32Array) =>
        options.onFrame(audio, vad.probability ?? (audio[0] ? 0.95 : 0.01)),
      reset: vad.reset,
      dispose: vad.dispose,
    }));
  receive = null;
  autoEnd = true;
  micTrack.enabled = true;
  vi.stubGlobal("AudioContext", TestContext);
  vi.stubGlobal("AudioWorkletNode", TestWorklet);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async (constraints) =>
        constraints.video ? camera : stream,
      ),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Local Whisper call lifecycle", () => {
  it("rejects loud non-speech before Whisper or barge-in, but transcribes quiet speech confirmed by VAD", async () => {
    const input = options();
    const call = await playgroundWhisperVoiceService.start(input);
    vad.probability = 0.02;
    frames(80, 0.8);
    expect(local.transcribe).not.toHaveBeenCalled();
    expect(input.onTranscripts).not.toHaveBeenCalled();
    expect(input.sendTurn).not.toHaveBeenCalled();
    expect(input.onInputLevel).toHaveBeenLastCalledWith(0);
    vad.probability = 0.92;
    frames(11, 0.001);
    await vi.waitFor(() => expect(local.transcribe).toHaveBeenCalledOnce());
    expect(input.sendTurn).not.toHaveBeenCalled();
    vad.probability = 0.02;
    frames(19, 0.8);
    expect(input.onInputActive).toHaveBeenLastCalledWith(true);
    expect(input.sendTurn).not.toHaveBeenCalled();
    frames(1, 0.8);
    await vi.waitFor(() => expect(input.sendTurn).toHaveBeenCalledOnce());
    await call.end();
    expect(vad.dispose).toHaveBeenCalledOnce();
  });

  it("keeps previews entirely local even after twelve recognition updates", async () => {
    const input = options();
    const call = await playgroundWhisperVoiceService.start(input);
    frames(11);
    for (let count = 1; count <= 14; count++) {
      await vi.waitFor(() =>
        expect(local.transcribe).toHaveBeenCalledTimes(count),
      );
      await Promise.resolve();
      if (count < 14) frames(10);
    }
    expect(input.sendTurn).not.toHaveBeenCalled();
    frames(20, 0);
    await vi.waitFor(() => expect(input.sendTurn).toHaveBeenCalledOnce());
    expect(vi.mocked(input.sendTurn!).mock.calls[0][0]).toMatchObject({
      transcript: "Hello",
    });
    expect(vi.mocked(input.sendTurn!).mock.calls[0][0]).not.toHaveProperty(
      "audio",
    );
    await call.end();
    expect(local.dispose).toHaveBeenCalledOnce();
  });

  it.each(["end", "barge-in", "failure"])(
    "removes a provisional YOU row when final local STT is interrupted by %s",
    async (action) => {
      const input = options();
      let reject!: (error: Error) => void;
      local.transcribe
        .mockResolvedValueOnce("Unfinished draft")
        .mockImplementationOnce(
          () =>
            new Promise<string>((_, fail) => {
              reject = fail;
            }),
        );
      const call = await playgroundWhisperVoiceService.start(input);
      frames(11);
      await vi.waitFor(() =>
        expect(input.onTranscripts).toHaveBeenLastCalledWith([
          { id: 0, role: "user", text: "Unfinished draft", complete: false },
        ]),
      );
      frames(20, 0);
      expect(input.sendTurn).not.toHaveBeenCalled();
      if (action === "end") await call.end();
      else if (action === "barge-in") frames(2);
      else reject(new Error("Final STT failed"));
      await vi.waitFor(() =>
        expect(input.onTranscripts).toHaveBeenLastCalledWith([]),
      );
      expect(local.transcribe.mock.calls[1][1].signal.aborted).toBe(true);
      expect(input.sendTurn).not.toHaveBeenCalled();
      await call.end();
    },
  );

  it("revises one provisional YOU row, keeps drafts out of history, and finalizes only after two seconds", async () => {
    const input = options();
    local.transcribe
      .mockReset()
      .mockResolvedValueOnce("I want")
      .mockResolvedValueOnce("I would like some help")
      .mockResolvedValueOnce("Hello");
    const call = await playgroundWhisperVoiceService.start(input);
    frames(11);
    await vi.waitFor(() =>
      expect(input.onTranscripts).toHaveBeenLastCalledWith([
        { id: 0, role: "user", text: "I want", complete: false },
      ]),
    );
    expect(input.sendTurn).not.toHaveBeenCalled();
    frames(10);
    await vi.waitFor(() =>
      expect(input.onTranscripts).toHaveBeenLastCalledWith([
        {
          id: 0,
          role: "user",
          text: "I would like some help",
          complete: false,
        },
      ]),
    );
    frames(19, 0);
    expect(input.sendTurn).not.toHaveBeenCalled();
    expect(local.transcribe).toHaveBeenCalledTimes(2);
    frames(1, 0);
    await vi.waitFor(() => expect(sourceStart).toHaveBeenCalledTimes(2));
    expect(vi.mocked(input.sendTurn!).mock.calls[0][0].messages).toEqual([]);
    expect(input.onTranscripts).toHaveBeenLastCalledWith([
      { id: 0, role: "user", text: "Hello", complete: true },
      { id: 1, role: "assistant", text: "How are you?", complete: true },
    ]);
    await call.end();
  });

  it("serializes interim requests, ignores late previews after submission, and removes a no-speech draft", async () => {
    const input = options();
    let late!: (text: string) => void;
    local.transcribe
      .mockReset()
      .mockResolvedValueOnce("Maybe noise")
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            late = resolve;
          }),
      );
    local.transcribe.mockResolvedValueOnce(".");
    const call = await playgroundWhisperVoiceService.start(input);
    frames(11);
    await vi.waitFor(() => expect(input.onTranscripts).toHaveBeenCalled());
    frames(10);
    const preview = vi.mocked(local.transcribe).mock.calls[1][1];
    frames(40);
    expect(local.transcribe).toHaveBeenCalledTimes(2);
    frames(20, 0);
    expect(preview.signal.aborted).toBe(true);
    late("Stale preview");
    await vi.waitFor(() =>
      expect(input.onTranscripts).toHaveBeenLastCalledWith([]),
    );
    expect(sourceStart).not.toHaveBeenCalled();
    expect(input.onStatus).toHaveBeenLastCalledWith("connected");
    expect(input.onError).not.toHaveBeenCalled();
    await call.end();
  });

  it.each(["mute", "end"])(
    "aborts interim transcription on %s and discards pending speech",
    async (action) => {
      const input = options();
      let late!: (text: string) => void;
      local.transcribe.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            late = resolve;
          }),
      );
      const call = await playgroundWhisperVoiceService.start(input);
      frames(11);
      const preview = vi.mocked(local.transcribe).mock.calls[0][1];
      if (action === "mute") call.mute(true);
      else await call.end();
      expect(preview.signal.aborted).toBe(true);
      late("Should not appear");
      await Promise.resolve();
      expect(input.onTranscripts).not.toHaveBeenCalled();
      expect(input.sendTurn).not.toHaveBeenCalled();
      await call.end();
    },
  );

  it("holds an active input turn through silence, resets on speech, and clears on submission/mute/end", async () => {
    const input = options();
    const call = await playgroundWhisperVoiceService.start(input);
    const voiced = {
      data: new Float32Array(1600).fill(0.1),
    } as MessageEvent<Float32Array>;
    const quiet = {
      data: new Float32Array(1600),
    } as MessageEvent<Float32Array>;
    receive?.(voiced);
    receive?.(voiced);
    expect(input.onInputActive).toHaveBeenLastCalledWith(true);
    for (let i = 0; i < 19; i++) receive?.(quiet);
    expect(input.onInputLevel).toHaveBeenLastCalledWith(0);
    expect(input.onInputActive).toHaveBeenLastCalledWith(true);
    expect(input.sendTurn).not.toHaveBeenCalled();
    receive?.(voiced);
    for (let i = 0; i < 19; i++) receive?.(quiet);
    expect(input.onInputActive).toHaveBeenLastCalledWith(true);
    expect(input.sendTurn).not.toHaveBeenCalled();
    receive?.(quiet);
    expect(input.onInputActive).toHaveBeenLastCalledWith(false);
    expect(input.onPhase).toHaveBeenLastCalledWith("transcribing");
    await vi.waitFor(() => expect(input.sendTurn).toHaveBeenCalledOnce());
    receive?.(voiced);
    receive?.(voiced);
    call.mute(true);
    expect(input.onInputActive).toHaveBeenLastCalledWith(false);
    call.mute(false);
    for (let i = 0; i < 20; i++) receive?.(quiet);
    expect(input.sendTurn).toHaveBeenCalledOnce();
    receive?.(voiced);
    receive?.(voiced);
    expect(input.onInputActive).toHaveBeenLastCalledWith(true);
    await call.end();
    expect(input.onInputActive).toHaveBeenLastCalledWith(false);
  });

  it("keeps listening after no speech without rows/audio and accepts the next real turn", async () => {
    const input = options();
    local.transcribe.mockResolvedValueOnce(".");
    const call = await playgroundWhisperVoiceService.start(input);
    speak();
    await vi.waitFor(() =>
      expect(input.onPhase).toHaveBeenLastCalledWith("listening"),
    );
    expect(input.onTranscripts).not.toHaveBeenCalled();
    expect(sourceStart).not.toHaveBeenCalled();
    expect(input.onError).not.toHaveBeenCalled();
    expect(input.onStatus).toHaveBeenLastCalledWith("connected");
    expect(micTrack.stop).not.toHaveBeenCalled();
    speak();
    await vi.waitFor(() => expect(sourceStart).toHaveBeenCalledTimes(2));
    expect(vi.mocked(input.sendTurn!).mock.calls[0][0].messages).toEqual([]);
    expect(input.onTranscripts).toHaveBeenLastCalledWith([
      expect.objectContaining({ role: "user", text: "Hello" }),
      expect.objectContaining({ role: "assistant", text: "How are you?" }),
    ]);
    await call.end();
  });

  it("keeps a microphone permission failure visible after delayed audio cleanup", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
      new DOMException("Denied", "NotAllowedError"),
    );
    let closed!: () => void;
    closeContext.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          closed = resolve;
        }),
    );
    const input = options();
    await expect(playgroundWhisperVoiceService.start(input)).rejects.toThrow(
      "Allow microphone access",
    );
    expect(input.onStatus).toHaveBeenLastCalledWith("failed");
    closed();
    await Promise.resolve();
    await Promise.resolve();
    expect(input.onStatus).toHaveBeenLastCalledWith("failed");
    expect(input.onStatus).not.toHaveBeenCalledWith("ended");
  });
  it("sends only locally recognized text on the chosen account, prints both sides, plays every clip and remembers history", async () => {
    const input = options();
    const call = await playgroundWhisperVoiceService.start(input);
    speak();
    await vi.waitFor(() =>
      expect(input.onPhase).toHaveBeenLastCalledWith("listening"),
    );
    expect(input.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "chosen-account",
        organizationId: "chosen-org",
        model: "openai/gpt-oss-20b",
        messages: [],
      }),
    );
    expect(input.onTranscripts).toHaveBeenCalledWith([
      expect.objectContaining({ role: "user", text: "Hello" }),
      expect.objectContaining({ role: "assistant", text: "How are you?" }),
    ]);
    expect(sourceStart).toHaveBeenCalledTimes(2);
    speak();
    await vi.waitFor(() => expect(input.sendTurn).toHaveBeenCalledTimes(2));
    expect(vi.mocked(input.sendTurn!).mock.calls[1][0].messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "How are you?" },
    ]);
    await call.end();
    expect(micTrack.stop).toHaveBeenCalled();
    expect(cameraTrack.stop).toHaveBeenCalled();
    expect(closeContext).toHaveBeenCalled();
  });

  it("streams transcript before audio, interrupts playback, and discards late deltas and clips", async () => {
    const input = options();
    autoEnd = false;
    const turns: Parameters<
      NonNullable<PlaygroundVoiceStartOptions["sendTurn"]>
    >[0][] = [];
    input.sendTurn = vi.fn((turn) => {
      turns.push(turn);
      return new Promise<PlaygroundWhisperTurnResult>(() => {});
    });
    const call = await playgroundWhisperVoiceService.start(input);
    speak();
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const first = turns[0];
    first.onEvent?.({ type: "transcript", text: "Hello" });
    first.onEvent?.({ type: "delta", text: "How " });
    expect(input.onTranscripts).toHaveBeenLastCalledWith([
      expect.objectContaining({ role: "user", text: "Hello", complete: true }),
      expect.objectContaining({
        role: "assistant",
        text: "How ",
        complete: false,
      }),
    ]);
    expect(sourceStart).not.toHaveBeenCalled();
    first.onEvent?.({ type: "audio", audio: btoa("wave") });
    first.onEvent?.({ type: "audio", audio: btoa("queued") });
    await vi.waitFor(() => expect(sourceStart).toHaveBeenCalledTimes(2));
    for (let i = 0; i < 2; i++)
      receive?.({
        data: new Float32Array(1600).fill(0.1),
      } as MessageEvent<Float32Array>);
    expect(first.signal.aborted).toBe(true);
    expect(sourceStop).toHaveBeenCalledTimes(2);
    expect(turns).toHaveLength(1);
    first.onEvent?.({ type: "delta", text: "stale reply" });
    first.onEvent?.({ type: "audio", audio: btoa("stale") });
    for (let i = 0; i < 19; i++)
      receive?.({ data: new Float32Array(1600) } as MessageEvent<Float32Array>);
    expect(turns).toHaveLength(1);
    receive?.({ data: new Float32Array(1600) } as MessageEvent<Float32Array>);
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1].messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "How " },
    ]);
    turns[1].onEvent?.({ type: "transcript", text: "Let me finish" });
    turns[1].onEvent?.({ type: "delta", text: "Go ahead" });
    await Promise.resolve();
    expect(sourceStart).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify(vi.mocked(input.onTranscripts).mock.lastCall),
    ).not.toContain("stale");
    await call.end();
  });

  it("interrupts while waiting for a reply and starts with saved media preferences", async () => {
    const input = options();
    input.voiceEnabled = false;
    input.cameraEnabled = false;
    input.sendTurn = vi.fn(
      () => new Promise<PlaygroundWhisperTurnResult>(() => {}),
    );
    const call = await playgroundWhisperVoiceService.start(input);
    expect(micTrack.enabled).toBe(false);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    speak();
    expect(input.sendTurn).not.toHaveBeenCalled();
    call.mute(false);
    speak();
    await vi.waitFor(() => expect(input.sendTurn).toHaveBeenCalledOnce());
    const first = vi.mocked(input.sendTurn!).mock.calls[0][0];
    speak();
    expect(first.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(input.sendTurn).toHaveBeenCalledTimes(2));
    expect(input.onError).not.toHaveBeenCalled();
    await call.end();
  });

  it("mutes microphone capture and ignores late turn responses after abort", async () => {
    const input = options();
    const controller = new AbortController();
    input.signal = controller.signal;
    let resolve!: (value: PlaygroundWhisperTurnResult) => void;
    input.sendTurn = vi.fn<
      NonNullable<PlaygroundVoiceStartOptions["sendTurn"]>
    >(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const call = await playgroundWhisperVoiceService.start(input);
    call.mute(true);
    expect(input.onInputLevel).toHaveBeenLastCalledWith(0);
    speak();
    expect(input.sendTurn).not.toHaveBeenCalled();
    call.mute(false);
    speak();
    await vi.waitFor(() => expect(input.sendTurn).toHaveBeenCalledOnce());
    controller.abort();
    expect(vi.mocked(input.sendTurn!).mock.calls[0][0].signal.aborted).toBe(
      true,
    );
    resolve({
      transcript: "Late",
      reply: "Do not play",
      audio: [btoa("wave")],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(input.onTranscripts).toHaveBeenLastCalledWith([
      expect.objectContaining({ role: "user", text: "Hello", complete: true }),
    ]);
    expect(sourceStart).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(input.onStatus).toHaveBeenLastCalledWith("ended"),
    );
  });

  it("does not replay a failed provider turn and releases media", async () => {
    const input = options();
    input.sendTurn = vi.fn().mockRejectedValue(new Error("Groq quota reached"));
    await playgroundWhisperVoiceService.start(input);
    speak();
    await vi.waitFor(() =>
      expect(input.onError).toHaveBeenCalledWith("Groq quota reached"),
    );
    speak();
    expect(input.sendTurn).toHaveBeenCalledOnce();
    expect(micTrack.stop).toHaveBeenCalled();
    expect(input.onStatus).toHaveBeenLastCalledWith("failed");
  });

  it("reports actual mic levels and remains ending until audio cleanup finishes", async () => {
    const input = options();
    const call = await playgroundWhisperVoiceService.start(input);
    receive?.({ data: new Float32Array(1600) } as MessageEvent<Float32Array>);
    expect(input.onInputLevel).toHaveBeenLastCalledWith(0);
    receive?.({
      data: new Float32Array(1600).fill(0.1),
    } as MessageEvent<Float32Array>);
    expect(vi.mocked(input.onInputLevel!).mock.lastCall?.[0]).toBeCloseTo(0.1);
    let closed!: () => void;
    closeContext.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          closed = resolve;
        }),
    );
    const ending = call.end();
    expect(input.onStatus).toHaveBeenLastCalledWith("ending");
    expect(input.onInputLevel).toHaveBeenLastCalledWith(0);
    closed();
    await ending;
    expect(input.onStatus).toHaveBeenLastCalledWith("ended");
  });
});
