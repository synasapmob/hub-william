import { afterEach, describe, expect, it, vi } from "vitest";
import preload from "./playground-speech-preload";

const models = vi.hoisted(() => ({ stt: vi.fn(), vad: vi.fn(), tts: vi.fn() }));
vi.mock("./playground-local-stt", () => ({ default: { start: models.stt } }));
vi.mock("./playground-local-vad", () => ({ default: { start: models.vad } }));
vi.mock("./playground-local-tts", () => ({ default: { start: models.tts } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Playground speech preloading", () => {
  it("prepares again when a new page reacquires a failed entry before cleanup", async () => {
    vi.stubGlobal("Worker", class {});
    models.stt
      .mockRejectedValueOnce(new Error("Download failed"))
      .mockResolvedValue({});
    models.vad.mockResolvedValue({});
    models.tts.mockResolvedValue({});
    const leaveFirst = preload.preload();
    await vi.waitFor(() =>
      expect(models.stt.mock.calls[0][0].signal.aborted).toBe(true),
    );
    leaveFirst();
    const leaveSecond = preload.preload();
    await Promise.resolve();
    expect(models.stt).toHaveBeenCalledTimes(2);
    expect(models.stt.mock.lastCall?.[0].signal.aborted).toBe(false);
    leaveSecond();
    await Promise.resolve();
    expect(models.stt.mock.lastCall?.[0].signal.aborted).toBe(true);
  });
  it("reuses preparation during effect replay and releases it after navigation", async () => {
    vi.stubGlobal("Worker", class {});
    models.stt.mockResolvedValue({});
    models.vad.mockResolvedValue({});
    models.tts.mockResolvedValue({});
    const leaveFirst = preload.preload();
    const signal = models.stt.mock.calls[0][0].signal;
    leaveFirst();
    const leaveSecond = preload.preload();
    await Promise.resolve();
    expect(signal.aborted).toBe(false);
    expect(models.stt).toHaveBeenCalledOnce();
    expect(models.vad).toHaveBeenCalledOnce();
    expect(models.tts).toHaveBeenCalledOnce();
    leaveSecond();
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
  });
  it("loads only models on entry and transfers the same workers to Start call", async () => {
    vi.stubGlobal("Worker", class {});
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const resources = { recognizer: {}, detector: {}, speech: {} };
    models.stt.mockResolvedValue(resources.recognizer);
    models.vad.mockResolvedValue(resources.detector);
    models.tts.mockResolvedValue(resources.speech);
    const leave = preload.preload();
    expect(models.stt).toHaveBeenCalledOnce();
    expect(models.vad).toHaveBeenCalledOnce();
    expect(models.tts).toHaveBeenCalledOnce();
    expect(getUserMedia).not.toHaveBeenCalled();
    const controller = new AbortController();
    const onFrame = vi.fn();
    expect(
      await preload.take({
        signal: controller.signal,
        onFrame,
        onError: vi.fn(),
      }),
    ).toEqual(resources);
    leave();
    const options = models.vad.mock.calls[0][0];
    expect(options.signal.aborted).toBe(false);
    const samples = new Float32Array(1600);
    options.onFrame(samples, 0.8);
    expect(onFrame).toHaveBeenCalledWith(samples, 0.8);
    controller.abort();
    expect(options.signal.aborted).toBe(true);
    expect(models.stt).toHaveBeenCalledOnce();
  });
  it("cancels unclaimed preparation on navigation and retries a failed warm load on explicit Start", async () => {
    vi.stubGlobal("Worker", class {});
    models.stt
      .mockRejectedValueOnce(new Error("Download failed"))
      .mockResolvedValue({});
    models.vad.mockResolvedValue({});
    models.tts.mockResolvedValue({});
    const leave = preload.preload();
    await vi.waitFor(() =>
      expect(models.stt.mock.calls[0][0].signal.aborted).toBe(true),
    );
    const controller = new AbortController();
    await preload.take({
      signal: controller.signal,
      onFrame: vi.fn(),
      onError: vi.fn(),
    });
    leave();
    expect(models.stt).toHaveBeenCalledTimes(2);
    controller.abort();
    const leaveNew = preload.preload();
    leaveNew();
    await Promise.resolve();
    expect(models.stt.mock.lastCall?.[0].signal.aborted).toBe(true);
  });
});
