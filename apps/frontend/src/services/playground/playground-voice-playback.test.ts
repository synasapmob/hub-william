import { afterEach, describe, expect, it, vi } from "vitest";
import PlaygroundVoicePlayback from "./playground-voice-playback";

// Two seconds of PCM: the timings below are in whole clip lengths.
const clip = { samples: new Float32Array(32000), sampleRate: 16000 };

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
    createBuffer: vi.fn((channels: number, length: number, rate: number) => ({
      numberOfChannels: channels,
      length,
      duration: length / rate,
      copyToChannel: vi.fn(),
    })),
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
  const playback = new PlaygroundVoicePlayback({
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

describe("buffered speech playback", () => {
  it("plays local PCM directly and routes it to the recording mix", async () => {
    const f = fixture();
    const samples = new Float32Array(22050).fill(0.1);
    f.playback.append({ samples, sampleRate: 22050 });
    const drained = f.playback.complete();
    await decoded();
    expect(f.context.createBuffer).toHaveBeenCalledWith(1, 22050, 22050);
    expect(f.nodes).toHaveLength(1);
    expect(f.nodes[0].connect).toHaveBeenCalledWith(f.context.destination);
    expect(f.nodes[0].connect).toHaveBeenCalledWith(f.recordingOutput);
    f.nodes[0].onended?.();
    await drained;
  });

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
    expect(f.context.createBuffer).toHaveBeenCalledTimes(3);
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
    let finish!: () => void;
    f.context.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    f.playback.append(clip);
    await decoded();
    f.controller.abort();
    finish();
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
    expect(f.context.createBuffer).toHaveBeenCalledTimes(4);
    expect(f.nodes).toHaveLength(2);
    f.playback.stop();
  });

  it("reports invalid decoded audio and resolves cancellation without late playback", async () => {
    const f = fixture();
    f.context.createBuffer.mockReturnValueOnce({
      numberOfChannels: 1,
      length: 1,
      duration: 0,
      copyToChannel: vi.fn(),
    });
    f.playback.append(clip);
    await f.playback.complete();
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.nodes).toHaveLength(0);
  });
});
