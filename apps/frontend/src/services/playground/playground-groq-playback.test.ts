import { afterEach, describe, expect, it, vi } from "vitest";
import PlaygroundGroqPlayback from "./playground-groq-playback";

const clip = btoa("wav fixture");
const buffer = { duration: 2, length: 32000, numberOfChannels: 1 };

function fixture() {
  const nodes: ReturnType<typeof source>[] = [];
  function source() {
    return {
      buffer: null,
      onended: null as (() => void) | null,
      start: vi.fn(),
      stop: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }
  const context = {
    currentTime: 10,
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi.fn().mockResolvedValue(buffer),
    createBufferSource: () => {
      const node = source();
      nodes.push(node);
      return node;
    },
  };
  const controller = new AbortController();
  const recordingOutput = {} as AudioNode;
  const onPhase = vi.fn();
  const onError = vi.fn();
  const playback = new PlaygroundGroqPlayback({
    context: context as unknown as AudioContext,
    signal: controller.signal,
    recordingOutput,
    onPhase,
    onError,
  });
  return {
    playback,
    context,
    controller,
    recordingOutput,
    onPhase,
    onError,
    nodes,
  };
}

async function decoded() {
  // Flush asynchronous decode/resume chains without advancing the audio clock.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("buffered Groq speech playback", () => {
  it("predecodes and schedules contiguous audio before the previous clip ends, including the recording mix", async () => {
    const f = fixture();
    f.playback.append(clip);
    await decoded();
    expect(f.nodes).toHaveLength(0);
    f.playback.append(clip);
    await decoded();
    expect(f.nodes).toHaveLength(2);
    expect(f.nodes[0].start).toHaveBeenCalledWith(10.02);
    expect(f.nodes[1].start).toHaveBeenCalledWith(12.02);
    f.playback.append(clip);
    await decoded();
    expect(f.context.decodeAudioData).toHaveBeenCalledTimes(3);
    expect(f.nodes).toHaveLength(2);
    const drained = vi.fn();
    void f.playback.complete().then(drained);
    f.context.currentTime = 12.02;
    f.nodes[0].onended?.();
    expect(f.nodes[2].start).toHaveBeenCalledWith(14.02);
    expect(f.onPhase).not.toHaveBeenCalledWith("thinking");
    for (const node of f.nodes) {
      expect(node.connect).toHaveBeenCalledWith(f.context.destination);
      expect(node.connect).toHaveBeenCalledWith(f.recordingOutput);
    }
    expect(drained).not.toHaveBeenCalled();
    f.nodes[1].onended?.();
    f.nodes[2].onended?.();
    await decoded();
    expect(drained).toHaveBeenCalledOnce();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("flushes a single-clip response on completion without waiting for a nonexistent second clip", async () => {
    const f = fixture();
    f.playback.append(clip);
    const drain = f.playback.complete();
    await decoded();
    expect(f.nodes).toHaveLength(1);
    f.nodes[0].onended?.();
    await drain;
  });

  it("bounds startup wait and re-buffers after a genuine upstream underrun", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.playback.append(clip);
    await decoded();
    await vi.advanceTimersByTimeAsync(1199);
    expect(f.nodes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.nodes).toHaveLength(1);
    f.context.currentTime = 13;
    f.nodes[0].onended?.();
    f.playback.append(clip);
    await decoded();
    expect(f.nodes).toHaveLength(1);
    f.playback.append(clip);
    await decoded();
    expect(f.nodes[1].start).toHaveBeenCalledWith(13.02);
    expect(f.nodes[2].start).toHaveBeenCalledWith(15.02);
    f.playback.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops all scheduled clips on interruption and ignores an in-flight decode", async () => {
    const f = fixture();
    f.playback.append(clip);
    f.playback.append(clip);
    await decoded();
    let finish!: (value: typeof buffer) => void;
    f.context.decodeAudioData.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.playback.append(clip);
    await decoded();
    f.controller.abort();
    finish(buffer);
    await decoded();
    await f.playback.complete();
    expect(f.nodes).toHaveLength(2);
    for (const node of f.nodes) {
      expect(node.stop).toHaveBeenCalledOnce();
      expect(node.disconnect).toHaveBeenCalledOnce();
    }
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("stops decoding when the small ready queue is full", async () => {
    const f = fixture();
    for (let i = 0; i < 10; i++) f.playback.append(clip);
    await decoded();
    expect(f.context.decodeAudioData).toHaveBeenCalledTimes(4);
    expect(f.nodes).toHaveLength(2);
    f.playback.stop();
  });

  it("reports invalid decoded audio and resolves cancellation without late playback", async () => {
    const f = fixture();
    f.context.decodeAudioData.mockResolvedValueOnce({ ...buffer, duration: 0 });
    f.playback.append(clip);
    await f.playback.complete();
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.nodes).toHaveLength(0);
  });
});
