import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startRecording, VOSK_MAX_RECORDING_SECONDS } from "./vosk-recorder";

type Handler = (event: { data?: Blob }) => void;

class FakeMediaRecorder {
  static supported = ["audio/webm"];
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = (type: string) =>
    FakeMediaRecorder.supported.includes(type);

  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  handlers = new Map<string, Handler>();

  stream: MediaStream;

  constructor(stream: MediaStream, options: { mimeType?: string }) {
    this.stream = stream;
    this.mimeType = options.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(event: string, handler: Handler) {
    this.handlers.set(event, handler);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.handlers.get("dataavailable")?.({
      data: new Blob([new Uint8Array([1, 2, 3])]),
    });
    this.handlers.get("stop")?.({});
  }
}

function fakeStream() {
  const track = { stop: vi.fn() };

  return {
    track,
    stream: { getTracks: () => [track] } as unknown as MediaStream,
  };
}

function stubMicrophone(getUserMedia: () => Promise<MediaStream>) {
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
}

describe("startRecording", () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.supported = ["audio/webm"];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("records to a file and releases the microphone on stop", async () => {
    const { stream, track } = fakeStream();
    stubMicrophone(() => Promise.resolve(stream));

    const recording = await startRecording();
    recording.stop();
    const file = await recording.result;

    expect(file.name).toBe("recording.webm");
    expect(file.type).toBe("audio/webm");
    expect(file.size).toBe(3);
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("uses an mp4 container where that is all the browser records", async () => {
    FakeMediaRecorder.supported = ["audio/mp4"];
    stubMicrophone(() => Promise.resolve(fakeStream().stream));

    const recording = await startRecording();
    recording.stop();

    expect((await recording.result).name).toBe("recording.m4a");
  });

  it("discards the audio and releases the microphone on cancel", async () => {
    const { stream, track } = fakeStream();
    stubMicrophone(() => Promise.resolve(stream));

    const recording = await startRecording();
    recording.cancel();

    await expect(recording.result).rejects.toThrow("cancelled");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("stops by itself at the time limit", async () => {
    vi.useFakeTimers();
    stubMicrophone(() => Promise.resolve(fakeStream().stream));

    const recording = await startRecording();
    await vi.advanceTimersByTimeAsync(VOSK_MAX_RECORDING_SECONDS * 1000);

    await expect(recording.result).resolves.toBeInstanceOf(File);
  });

  it.each([
    ["NotAllowedError", "blocked"],
    ["NotFoundError", "No microphone"],
    ["NotReadableError", "in use"],
  ])("explains a %s failure", async (name, message) => {
    stubMicrophone(() => Promise.reject(new DOMException("denied", name)));

    await expect(startRecording()).rejects.toThrow(message);
  });

  it("explains when the browser cannot record at all", async () => {
    vi.stubGlobal("navigator", {});

    await expect(startRecording()).rejects.toThrow("unavailable");
  });
});
