import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import playgroundLocalSttService from "./playground-local-stt";
import type {
  PlaygroundLocalSttRequest,
  PlaygroundLocalSttResponse,
} from "./playground-local-stt-protocol";

class TestWorker {
  static latest: TestWorker;
  onmessage:
    ((event: MessageEvent<PlaygroundLocalSttResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    TestWorker.latest = this;
  }
  emit(data: PlaygroundLocalSttResponse) {
    this.onmessage?.({ data } as MessageEvent<PlaygroundLocalSttResponse>);
  }
  last(): PlaygroundLocalSttRequest {
    return this.postMessage.mock.lastCall![0];
  }
}

beforeEach(() => vi.stubGlobal("Worker", TestWorker));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser speech recognition", () => {
  it("loads on demand, streams real worker partials, and never uploads microphone audio", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    const onLoading = vi.fn();
    const starting = playgroundLocalSttService.start({
      signal: controller.signal,
      onLoading,
    });
    const worker = TestWorker.latest;
    expect(worker.last().type).toBe("load");
    expect(onLoading).toHaveBeenCalledWith("Loading speech recognition…");
    worker.emit({ id: worker.last().id, type: "ready" });
    const model = await starting;
    expect(onLoading).toHaveBeenLastCalledWith(null);
    const onText = vi.fn();
    const audio = new Float32Array(16000);
    const reading = model.transcribe(audio, {
      signal: controller.signal,
      onText,
    });
    const request = worker.last();
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      { id: request.id, type: "transcribe", audio },
      [audio.buffer],
    );
    worker.emit({ id: request.id, type: "partial", text: "I want" });
    expect(onText).toHaveBeenLastCalledWith("I want");
    worker.emit({ id: request.id, type: "partial", text: "I want to learn" });
    worker.emit({
      id: request.id,
      type: "complete",
      text: "I want to learn English.",
    });
    await expect(reading).resolves.toBe("I want to learn English.");
    expect(onText).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    model.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
    fetch.mockRestore();
  });

  it("cancels obsolete recognition and ignores its late partials while the final completes", async () => {
    const controller = new AbortController();
    const starting = playgroundLocalSttService.start({
      signal: controller.signal,
    });
    const worker = TestWorker.latest;
    worker.emit({ id: worker.last().id, type: "ready" });
    const model = await starting;
    const preview = new AbortController();
    const onText = vi.fn();
    const reading = model.transcribe(new Float32Array(16000), {
      signal: preview.signal,
      onText,
    });
    const rejected = expect(reading).rejects.toMatchObject({
      name: "AbortError",
    });
    const old = worker.last().id;
    preview.abort();
    await rejected;
    expect(worker.last()).toEqual({ id: old, type: "cancel" });
    const final = model.transcribe(new Float32Array(32000), {
      signal: controller.signal,
      onText,
    });
    worker.emit({ id: old, type: "partial", text: "stale" });
    worker.emit({ id: old, type: "complete", text: "stale" });
    expect(onText).not.toHaveBeenCalled();
    worker.emit({
      id: worker.last().id,
      type: "complete",
      text: "Final words",
    });
    await expect(final).resolves.toBe("Final words");
    controller.abort();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("ends during model loading without leaving a worker or pending promise", async () => {
    const controller = new AbortController();
    const starting = playgroundLocalSttService.start({
      signal: controller.signal,
    });
    const rejected = expect(starting).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    expect(TestWorker.latest.terminate).toHaveBeenCalledOnce();
  });

  it("releases stalled inference on timeout instead of silently using a provider", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const starting = playgroundLocalSttService.start({ signal });
    const worker = TestWorker.latest;
    worker.emit({ id: worker.last().id, type: "ready" });
    const model = await starting;
    const reading = model.transcribe(new Float32Array(16000), {
      signal,
      onText: vi.fn(),
    });
    const rejected = expect(reading).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(60000);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
