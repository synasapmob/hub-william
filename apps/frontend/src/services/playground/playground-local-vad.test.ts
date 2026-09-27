import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import playgroundLocalVadService from "./playground-local-vad";
import type { PlaygroundLocalVadResponse } from "./playground-local-vad-protocol";

class TestWorker {
  static latest: TestWorker;
  onmessage:
    ((event: MessageEvent<PlaygroundLocalVadResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    TestWorker.latest = this;
  }
  emit(data: PlaygroundLocalVadResponse) {
    this.onmessage?.({ data } as MessageEvent<PlaygroundLocalVadResponse>);
  }
}

beforeEach(() => vi.stubGlobal("Worker", TestWorker));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("local speech detection worker", () => {
  it("transfers audio locally, clears pending frames on mute and ignores late results after reset/end", async () => {
    const controller = new AbortController();
    const onFrame = vi.fn();
    const onError = vi.fn();
    const starting = playgroundLocalVadService.start({
      signal: controller.signal,
      onFrame,
      onError,
    });
    const worker = TestWorker.latest;
    worker.emit({ type: "ready", epoch: 0 });
    const vad = await starting;
    const audio = new Float32Array(1600);
    vad.push(audio);
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      { type: "frame", epoch: 0, audio },
      [audio.buffer],
    );
    vad.reset();
    worker.emit({ type: "frame", epoch: 0, audio, probability: 0.9 });
    expect(onFrame).not.toHaveBeenCalled();
    vad.push(audio);
    worker.emit({ type: "frame", epoch: 1, audio, probability: 0.7 });
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(audio, 0.7);
    controller.abort();
    worker.emit({ type: "frame", epoch: 1, audio, probability: 0.9 });
    expect(onFrame).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("bounds inference backlog and stops instead of passing unchecked audio to Whisper", async () => {
    const onError = vi.fn();
    const onFrame = vi.fn();
    const starting = playgroundLocalVadService.start({
      signal: new AbortController().signal,
      onFrame,
      onError,
    });
    const worker = TestWorker.latest;
    worker.emit({ type: "ready", epoch: 0 });
    const vad = await starting;
    for (let i = 0; i < 21; i++) vad.push(new Float32Array(1600));
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining("cannot keep up"),
      }),
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(onFrame).not.toHaveBeenCalled();
    expect(
      worker.postMessage.mock.calls.filter(
        ([message]) => message.type === "frame",
      ),
    ).toHaveLength(20);
  });

  it.each(["abort", "error", "timeout"])(
    "releases model loading on %s",
    async (reason) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const onError = vi.fn();
      const starting = playgroundLocalVadService.start({
        signal: controller.signal,
        onFrame: vi.fn(),
        onError,
      });
      const rejected = expect(starting).rejects.toThrow();
      if (reason === "abort") controller.abort();
      if (reason === "error") TestWorker.latest.onerror?.();
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(60000);
      await rejected;
      expect(TestWorker.latest.terminate).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
    },
  );
});
