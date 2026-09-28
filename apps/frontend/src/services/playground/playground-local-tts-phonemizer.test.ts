import { beforeEach, describe, expect, it, vi } from "vitest";
import phonemizer from "./playground-local-tts-phonemizer";

interface TestPiperOptions {
  print: (text: string) => void;
}

const runtime = vi.hoisted(() => ({ callMain: vi.fn() }));
vi.mock("./playground-local-tts-assets", () => ({
  default: { load: async () => new ArrayBuffer(1) },
}));
vi.mock("@diffusionstudio/piper-wasm/build/piper_phonemize.js", () => ({
  default: async (options: TestPiperOptions) => ({
    callMain: (args: string[]) => {
      runtime.callMain(args);
      options.print(JSON.stringify({ phoneme_ids: [1, 2, 3] }));
    },
  }),
}));
beforeEach(() => vi.clearAllMocks());

describe("English-only Piper phonemization", () => {
  it("always selects eSpeak en regardless of text content", async () => {
    const process = await phonemizer.load();
    for (const text of ["Hello world.", "Xin chào."]) {
      await expect(process(text)).resolves.toEqual([1, 2, 3]);
      expect(runtime.callMain).toHaveBeenLastCalledWith([
        "-l",
        "en",
        "--input",
        JSON.stringify([{ text }]),
        "--espeak_data",
        "/espeak-ng-data",
      ]);
    }
  });
});
