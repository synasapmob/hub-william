import {
  LogitsProcessor,
  LogitsProcessorList,
  Tensor,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";

class PlaygroundLanguageTokens extends LogitsProcessor {
  private allowed: Set<number>;

  constructor(tokens: number[]) {
    super();
    this.allowed = new Set(tokens);
  }

  override _call(_inputIds: bigint[][], logits: Tensor): Tensor {
    const scores = logits.data;
    if (!(scores instanceof Float32Array))
      throw new Error("Invalid language detection scores.");
    const vocabulary = logits.dims.at(-1)!;
    for (let index = 0; index < scores.length; index++)
      if (!this.allowed.has(index % vocabulary)) scores[index] = -Infinity;
    return logits;
  }
}

export default async function playgroundLocalSttLanguage(
  recognizer: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array,
): Promise<string> {
  const config = recognizer.model.generation_config;
  if (
    !config ||
    !Number.isInteger(config.decoder_start_token_id) ||
    !("lang_to_id" in config) ||
    !config.lang_to_id ||
    typeof config.lang_to_id !== "object"
  )
    throw new Error("This speech model cannot detect the spoken language.");
  const languages = Object.entries(config.lang_to_id).filter(
    (entry): entry is [string, number] =>
      /^<\|[a-z]{2,3}\|>$/.test(entry[0]) &&
      typeof entry[1] === "number" &&
      Number.isInteger(entry[1]) &&
      entry[1] >= 0,
  );
  if (!languages.length) throw new Error("Speech language tokens are missing.");
  const processors = new LogitsProcessorList();
  processors.push(new PlaygroundLanguageTokens(languages.map(([, id]) => id)));
  const inputs = await recognizer.processor(audio);
  let tokens: Tensor | undefined;
  try {
    // The first Whisper token after start-of-transcript predicts the language.
    // Explicit decoder IDs bypass this library version's English-only default.
    // generate() owns decoder-cache cleanup, unlike a raw forward() call.
    const result = await recognizer.model.generate({
      inputs: inputs.input_features,
      decoder_input_ids: [config.decoder_start_token_id],
      max_new_tokens: 1,
      do_sample: false,
      return_timestamps: false,
      return_dict_in_generate: false,
      suppress_tokens: [],
      begin_suppress_tokens: [],
      logits_processor: processors,
    });
    if (!(result instanceof Tensor))
      throw new Error("Speech language detection returned invalid tokens.");
    tokens = result;
    const token = Number(tokens.data[1]);
    const language = languages.find(([, id]) => id === token)?.[0];
    if (!language)
      throw new Error("The spoken language could not be detected.");
    return language.slice(2, -2);
  } finally {
    tokens?.dispose();
    for (const value of Object.values(inputs))
      if (value instanceof Tensor) value.dispose();
  }
}
