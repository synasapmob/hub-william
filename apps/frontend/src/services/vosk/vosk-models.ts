/** Vosk models the browser build can run, served as `.tar.gz` by vosk-browser. */
export interface VoskModel {
  id: string;
  label: string;
  url: string;
  /** Download size shown before the first use. */
  size: string;
}

const MODEL_ORIGIN = "https://ccoreilly.github.io/vosk-browser/models";

export const VOSK_MODELS: readonly VoskModel[] = [
  {
    id: "en-us",
    label: "English (US)",
    url: `${MODEL_ORIGIN}/vosk-model-small-en-us-0.15.tar.gz`,
    size: "41 MB",
  },
  {
    id: "en-in",
    label: "English (India)",
    url: `${MODEL_ORIGIN}/vosk-model-small-en-in-0.4.tar.gz`,
    size: "38 MB",
  },
  {
    id: "vi",
    label: "Vietnamese",
    url: `${MODEL_ORIGIN}/vosk-model-small-vn-0.3.tar.gz`,
    size: "34 MB",
  },
  {
    id: "zh",
    label: "Chinese",
    url: `${MODEL_ORIGIN}/vosk-model-small-cn-0.3.tar.gz`,
    size: "33 MB",
  },
  {
    id: "fr",
    label: "French",
    url: `${MODEL_ORIGIN}/vosk-model-small-fr-pguyot-0.3.tar.gz`,
    size: "46 MB",
  },
  {
    id: "es",
    label: "Spanish",
    url: `${MODEL_ORIGIN}/vosk-model-small-es-0.3.tar.gz`,
    size: "34 MB",
  },
  {
    id: "de",
    label: "German",
    url: `${MODEL_ORIGIN}/vosk-model-small-de-0.15.tar.gz`,
    size: "46 MB",
  },
  {
    id: "ru",
    label: "Russian",
    url: `${MODEL_ORIGIN}/vosk-model-small-ru-0.4.tar.gz`,
    size: "41 MB",
  },
  {
    id: "it",
    label: "Italian",
    url: `${MODEL_ORIGIN}/vosk-model-small-it-0.4.tar.gz`,
    size: "34 MB",
  },
  {
    id: "pt",
    label: "Portuguese",
    url: `${MODEL_ORIGIN}/vosk-model-small-pt-0.3.tar.gz`,
    size: "32 MB",
  },
  {
    id: "tr",
    label: "Turkish",
    url: `${MODEL_ORIGIN}/vosk-model-small-tr-0.3.tar.gz`,
    size: "37 MB",
  },
];
