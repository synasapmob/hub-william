import createPiperPhonemize from "@diffusionstudio/piper-wasm/build/piper_phonemize.js";
import wasmUrl from "@diffusionstudio/piper-wasm/build/piper_phonemize.wasm?url";
import dataUrl from "@diffusionstudio/piper-wasm/build/piper_phonemize.data?url";
import { z } from "zod";
import playgroundLocalTtsAssets from "./playground-local-tts-assets";

const resultSchema = z.object({
  phoneme_ids: z.array(z.number().int().min(0).max(255)).min(1).max(2048),
});

async function load() {
  const [wasm, data] = await Promise.all([
    playgroundLocalTtsAssets.load({
      url: wasmUrl,
      bytes: 635212,
      sha256:
        "b777cd107a91d2bcc6a1ea46f2c26a662a7407394fe84589198aeaa83dd7a9d6",
    }),
    playgroundLocalTtsAssets.load({
      url: dataUrl,
      bytes: 18077249,
      sha256:
        "29f1025eb23a5b5c192cd14a6efbce4509402ff265405072ee6f7d1a09b78f8c",
    }),
  ]);
  return async (text: string) => {
    let result: number[] | undefined;
    let failure: unknown;
    const module = await createPiperPhonemize({
      wasmBinary: wasm,
      getPreloadedPackage: () => data,
      locateFile: (path) => (path.endsWith(".wasm") ? wasmUrl : dataUrl),
      print: (value) => {
        try {
          result = resultSchema.parse(JSON.parse(value)).phoneme_ids;
        } catch (error) {
          failure = error;
        }
      },
      printErr: (value) => {
        failure = new Error(value);
      },
      onAbort: (error) => {
        failure = error;
      },
    });
    module.callMain([
      "-l",
      "en",
      "--input",
      JSON.stringify([{ text }]),
      "--espeak_data",
      "/espeak-ng-data",
    ]);
    if (failure || !result)
      throw new Error("Local voice could not process this text.");
    return result;
  };
}

export default { load };
