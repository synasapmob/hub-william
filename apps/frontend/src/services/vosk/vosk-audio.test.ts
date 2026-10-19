import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeAudioFile,
  mixToMono,
  splitIntoChunks,
  VOSK_SAMPLE_RATE,
} from "./vosk-audio";

describe("mixToMono", () => {
  it("averages channels so neither speaker is dropped", () => {
    const mono = mixToMono([
      new Float32Array([1, 0.5, -1]),
      new Float32Array([0, 0.5, -0.5]),
    ]);

    expect(Array.from(mono)).toEqual([0.5, 0.5, -0.75]);
  });

  it("copies a single channel instead of aliasing the decoder's buffer", () => {
    const channel = new Float32Array([0.25, -0.25]);
    const mono = mixToMono([channel]);

    expect(mono).not.toBe(channel);
    expect(Array.from(mono)).toEqual([0.25, -0.25]);
  });

  it("returns silence for no channels", () => {
    expect(mixToMono([]).length).toBe(0);
  });
});

describe("splitIntoChunks", () => {
  it("cuts two-second chunks and keeps the remainder", () => {
    const twoSeconds = VOSK_SAMPLE_RATE * 2;
    const chunks = splitIntoChunks(new Float32Array(twoSeconds * 2 + 100));

    expect(chunks.map((chunk) => chunk.length)).toEqual([
      twoSeconds,
      twoSeconds,
      100,
    ]);
  });

  it("returns no chunks for empty audio", () => {
    expect(splitIntoChunks(new Float32Array(0))).toEqual([]);
  });
});

describe("decodeAudioFile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("decodes at the Vosk sample rate and mixes the result to mono", async () => {
    const decodeAudioData = vi.fn().mockResolvedValue({
      numberOfChannels: 2,
      getChannelData: (index: number) =>
        new Float32Array(index === 0 ? [1, 1] : [0, -1]),
    });
    const OfflineAudioContext = vi.fn(function () {
      return { decodeAudioData };
    });
    vi.stubGlobal("OfflineAudioContext", OfflineAudioContext);

    const samples = await decodeAudioFile(
      new File([new Uint8Array([1, 2, 3])], "clip.wav"),
    );

    expect(OfflineAudioContext).toHaveBeenCalledWith(1, 1, VOSK_SAMPLE_RATE);
    expect(Array.from(samples)).toEqual([0.5, 0]);
  });
});
