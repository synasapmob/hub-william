import {
  Tensor,
  type AutomaticSpeechRecognitionPipeline,
  type LogitsProcessorList,
} from "@huggingface/transformers";
import { describe, expect, it, vi } from "vitest";
import detectLanguage from "./playground-local-stt-language";

function recognizer(language: "vi" | "en") {
  const features = new Tensor("float32", new Float32Array(4), [1, 4]);
  const dispose = vi.spyOn(features, "dispose");
  const model = {
    generation_config: {
      decoder_start_token_id: 1,
      lang_to_id: { "<|en|>": 2, "<|vi|>": 3 },
    },
    generate: vi.fn(async (options) => {
      // Non-language output is deliberately more likely than either language.
      const logits = new Tensor(
        "float32",
        new Float32Array([
          100,
          100,
          language === "en" ? 5 : 1,
          language === "vi" ? 5 : 1,
        ]),
        [1, 4],
      );
      const processors = options.logits_processor as LogitsProcessorList;
      processors._call([[1n]], logits);
      expect(Array.from(logits.data).slice(0, 2)).toEqual([
        -Infinity,
        -Infinity,
      ]);
      const scores = Array.from(logits.data) as number[];
      const token = scores.indexOf(Math.max(...scores));
      return new Tensor(
        "int64",
        new BigInt64Array([1n, BigInt(token)]),
        [1, 2],
      );
    }),
  };
  const pipeline = {
    model,
    processor: vi.fn(async () => ({ input_features: features })),
  } as unknown as AutomaticSpeechRecognitionPipeline;
  return { pipeline, model, dispose };
}

describe("local speech language detection", () => {
  it.each(["vi", "en"] as const)(
    "detects %s from model language scores without translation",
    async (language) => {
      const { pipeline, model, dispose } = recognizer(language);
      expect(await detectLanguage(pipeline, new Float32Array(16000))).toBe(
        language,
      );
      expect(model.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          decoder_input_ids: [1],
          max_new_tokens: 1,
          return_dict_in_generate: false,
        }),
      );
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("cleans processor tensors when inference fails", async () => {
    const { pipeline, model, dispose } = recognizer("vi");
    model.generate.mockRejectedValueOnce(new Error("Device lost"));
    await expect(
      detectLanguage(pipeline, new Float32Array(16000)),
    ).rejects.toThrow("Device lost");
    expect(dispose).toHaveBeenCalledOnce();
  });
});
