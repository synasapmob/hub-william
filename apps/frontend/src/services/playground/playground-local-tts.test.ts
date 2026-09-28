import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import playgroundLocalTts from "./playground-local-tts";
import type { PlaygroundLocalTtsResponse } from "./playground-local-tts-protocol";

class TestWorker {
  static latest: TestWorker;
  onmessage:
    ((event: MessageEvent<PlaygroundLocalTtsResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    TestWorker.latest = this;
  }
  emit(data: PlaygroundLocalTtsResponse) {
    this.onmessage?.({ data } as MessageEvent<PlaygroundLocalTtsResponse>);
  }
}
beforeEach(() => vi.stubGlobal("Worker", TestWorker));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("local TTS worker ownership", () => {
  it("returns recordable PCM, cancels stale synthesis and terminates on End", async () => {
    const controller = new AbortController();
    const starting = playgroundLocalTts.start({ signal: controller.signal });
    const worker = TestWorker.latest;
    worker.emit({ id: 1, type: "ready" });
    const speech = await starting;
    const first = new AbortController();
    const pending = speech.synthesize("Hello", first.signal);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      id: 2,
      type: "synthesize",
      text: "Hello",
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    first.abort();
    await rejected;
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      id: 2,
      type: "cancel",
    });
    const next = speech.synthesize("Next sentence", controller.signal);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(4));
    worker.emit({
      id: 2,
      type: "audio",
      samples: Float32Array.of(1),
      sampleRate: 22050,
    });
    const samples = Float32Array.of(0.1, 0.2);
    worker.emit({ id: 3, type: "audio", samples, sampleRate: 22050 });
    await expect(next).resolves.toEqual({ samples, sampleRate: 22050 });
    controller.abort();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it.each(["error", "abort", "timeout"])(
    "releases initialization after %s",
    async (reason) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const pending = playgroundLocalTts.start({ signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow();
      if (reason === "error") TestWorker.latest.onerror?.();
      if (reason === "abort") controller.abort();
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(180000);
      await rejected;
      expect(TestWorker.latest.terminate).toHaveBeenCalledOnce();
    },
  );
  it("rejects malformed audio instead of playing it at the wrong sample rate", async () => {
    const controller = new AbortController();
    const starting = playgroundLocalTts.start({ signal: controller.signal });
    TestWorker.latest.emit({ id: 1, type: "ready" });
    const speech = await starting;
    const pending = speech.synthesize("Hello", controller.signal);
    TestWorker.latest.emit({
      id: 2,
      type: "audio",
      samples: Float32Array.of(0.1),
      sampleRate: 24000,
    });
    await expect(pending).rejects.toThrow("invalid audio");
    await expect(speech.synthesize(" ", controller.signal)).rejects.toThrow(
      "Invalid local speech segment",
    );
    controller.abort();
  });

  it("keeps the fixed English synthesis deadline at 60 seconds", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const starting = playgroundLocalTts.start({ signal: controller.signal });
    const worker = TestWorker.latest;
    worker.emit({ id: 1, type: "ready" });
    const speech = await starting;
    const pending = speech.synthesize("Hello world.", controller.signal);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(59999);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
