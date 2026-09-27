import type { PlaygroundVoiceAudioSources } from "./playground-voice";
import type { PlaygroundVoiceTranscript } from "./playground-voice-events";
import type { PlaygroundRecordingFile } from "./playground-recordings";

interface PlaygroundRecorderStartOptions {
  ownerId: string;
  model: string;
  camera: HTMLVideoElement;
  sources: PlaygroundVoiceAudioSources;
  transcripts: PlaygroundVoiceTranscript[];
  signal: AbortSignal;
}
export interface PlaygroundRecorderSession {
  stop: () => void;
  sources: (sources: PlaygroundVoiceAudioSources) => void;
  transcripts: (entries: PlaygroundVoiceTranscript[]) => void;
  result: Promise<PlaygroundRecordingFile>;
}

async function start(
  options: PlaygroundRecorderStartOptions,
): Promise<PlaygroundRecorderSession> {
  if (
    typeof MediaRecorder === "undefined" ||
    !HTMLCanvasElement.prototype.captureStream
  )
    throw new Error(
      "Recording is unavailable in this browser. Try Chrome or Safari.",
    );
  options.signal.throwIfAborted();
  const context = new AudioContext();
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const paint = canvas.getContext("2d");
  if (!paint) {
    void context.close();
    throw new Error("Could not prepare recording video.");
  }
  const output = context.createMediaStreamDestination();
  let video: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inputs: MediaStreamAudioSourceNode[] = [];
  let stopped = false;
  let entries: PlaygroundVoiceTranscript[] = [];
  const previous = new Set(
    options.transcripts
      .filter((entry) => entry.complete)
      .map((entry) => entry.id),
  );
  const createdAt = Date.now();
  let startedAt = 0;
  let duration = 0;
  const chunks: Blob[] = [];
  let bytes = 0;
  let stoppedAtLimit = false;
  let resolve!: (file: PlaygroundRecordingFile) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<PlaygroundRecordingFile>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  void result.catch(() => undefined);

  function cleanup() {
    clearInterval(timer);
    options.signal.removeEventListener("abort", stop);
    inputs.forEach((node) => node.disconnect());
    video?.getTracks().forEach((track) => track.stop());
    output.stream.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => undefined);
    // Borrowed microphone/BOT tracks belong to the call and are never stopped here.
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    duration = Math.max(0, performance.now() - startedAt);
    clearInterval(timer);
    if (recorder?.state !== "inactive") recorder?.stop();
  }
  function sources(next: PlaygroundVoiceAudioSources) {
    if (stopped) return;
    inputs.forEach((node) => node.disconnect());
    inputs = [next.microphone, next.bot].flatMap((stream) => {
      if (
        !stream?.getAudioTracks().some((track) => track.readyState === "live")
      )
        return [];
      const source = context.createMediaStreamSource(stream);
      source.connect(output); // Recording only: never route the microphone to speakers.
      return [source];
    });
  }
  function transcripts(next: PlaygroundVoiceTranscript[]) {
    if (!stopped)
      entries = next
        .filter((entry) => !previous.has(entry.id))
        .map((entry) => ({ ...entry }));
  }
  function draw() {
    paint!.fillStyle = "#18181b";
    paint!.fillRect(0, 0, canvas.width, canvas.height);
    const camera = options.camera;
    if (camera.srcObject && camera.readyState >= 2 && camera.videoWidth > 0) {
      const scale = Math.min(
        canvas.width / camera.videoWidth,
        canvas.height / camera.videoHeight,
      );
      const width = camera.videoWidth * scale;
      const height = camera.videoHeight * scale;
      // Canvas capture does not inherit the camera preview's CSS mirror.
      paint!.save();
      paint!.translate(canvas.width, 0);
      paint!.scale(-1, 1);
      paint!.drawImage(
        camera,
        (canvas.width - width) / 2,
        (canvas.height - height) / 2,
        width,
        height,
      );
      paint!.restore();
    } else {
      paint!.fillStyle = "#fafafa";
      paint!.font = "28px sans-serif";
      paint!.textAlign = "center";
      paint!.fillText("Camera is off", canvas.width / 2, canvas.height / 2);
    }
  }
  try {
    await context.resume();
    options.signal.throwIfAborted();
    sources(options.sources);
    transcripts(options.transcripts);
    draw();
    // A stable canvas track survives camera off/on without changing recorder tracks.
    video = canvas.captureStream(24);
    const stream = new MediaStream([
      ...video.getVideoTracks(),
      ...output.stream.getAudioTracks(),
    ]);
    const mimeType = [
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType)
      throw new Error("This browser has no supported video recording format.");
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 128_000,
    });
    recorder.ondataavailable = (event) => {
      if (event.data.size) {
        chunks.push(event.data);
        bytes += event.data.size;
        if (bytes >= 128 * 1024 * 1024) {
          stoppedAtLimit = true;
          stop();
        }
      }
    };
    recorder.onerror = () => {
      reject(new Error("Recording stopped unexpectedly. Please try again."));
      stop();
    };
    recorder.onstop = () => {
      if (!stopped) {
        stopped = true;
        duration = performance.now() - startedAt;
      }
      cleanup();
      const blob = new Blob(chunks, { type: recorder!.mimeType });
      if (!blob.size) {
        reject(new Error("No media was recorded. Try recording for longer."));
        return;
      }
      resolve({
        id: crypto.randomUUID(),
        ownerId: options.ownerId,
        createdAt,
        duration,
        model: options.model,
        mimeType: blob.type,
        stoppedAtLimit,
        blob,
        transcripts: entries,
      });
    };
    startedAt = performance.now();
    recorder.start(1000);
    timer = setInterval(draw, 1000 / 24);
    options.signal.addEventListener("abort", stop, { once: true });
    return { stop, sources, transcripts, result };
  } catch (error) {
    cleanup();
    throw error;
  }
}
const playgroundRecorderService = { start };
export default playgroundRecorderService;
