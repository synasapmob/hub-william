/** Keeps a forgotten recording from growing the decoded waveform without bound. */
export const VOSK_MAX_RECORDING_SECONDS = 10 * 60;

export interface VoskRecording {
  /** Resolves once recording ends, by stop(), the time limit or an error. */
  result: Promise<File>;
  /** Ask the recorder to finish; `result` delivers the audio. */
  stop: () => void;
  /** Throw the audio away and release the microphone. */
  cancel: () => void;
}

// Chrome and Firefox record webm/ogg; Safari only records mp4. Order matters:
// the first supported type wins, and the browser's own default is the fallback.
const PREFERRED_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

function microphoneError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error(
      "Microphone access was blocked. Allow it for this site and try again.",
    );
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new Error("No microphone was found.");
  }
  if (name === "NotReadableError") {
    return new Error("The microphone is in use by another application.");
  }

  return new Error("Could not start the microphone.");
}

function extensionFor(mimeType: string) {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";

  return "webm";
}

/** Record the microphone to a file the transcription pipeline can decode. */
export async function startRecording(): Promise<VoskRecording> {
  if (
    typeof MediaRecorder === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    throw new Error("Recording is unavailable in this browser or connection.");
  }

  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: true })
    .catch((error: unknown) => {
      throw microphoneError(error);
    });

  const mimeType = PREFERRED_TYPES.find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  const chunks: Blob[] = [];
  let discarded = false;

  const result = new Promise<File>((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("error", () => {
      stream.getTracks().forEach((track) => track.stop());
      reject(new Error("Recording failed."));
    });
    recorder.addEventListener("stop", () => {
      // Releasing the tracks is what turns off the browser's recording indicator.
      stream.getTracks().forEach((track) => track.stop());
      if (discarded) {
        reject(new Error("Recording cancelled."));
        return;
      }

      const type = recorder.mimeType || mimeType || "audio/webm";
      resolve(
        new File(chunks, `recording.${extensionFor(type)}`, {
          type,
        }),
      );
    });
  });
  // A cancelled recording rejects on purpose; nobody is waiting on it.
  result.catch(() => {});

  function stop() {
    if (recorder.state !== "inactive") recorder.stop();
  }

  const limit = setTimeout(stop, VOSK_MAX_RECORDING_SECONDS * 1000);
  void result.finally(() => clearTimeout(limit)).catch(() => {});
  recorder.start();

  return {
    result,
    stop,
    cancel() {
      discarded = true;
      stop();
    },
  };
}
