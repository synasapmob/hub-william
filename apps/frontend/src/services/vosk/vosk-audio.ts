/** Sample rate Vosk's small models are trained for. */
export const VOSK_SAMPLE_RATE = 16_000;

/** Largest file accepted; decoding holds the whole waveform in memory. */
export const VOSK_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Two seconds per message keeps progress granular without flooding the worker. */
const CHUNK_SECONDS = 2;

/** Average every channel into one so stereo recordings keep both speakers. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0].slice();

  const mono = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let index = 0; index < mono.length; index += 1) {
      mono[index] += channel[index] / channels.length;
    }
  }

  return mono;
}

export function splitIntoChunks(samples: Float32Array): Float32Array[] {
  const size = VOSK_SAMPLE_RATE * CHUNK_SECONDS;
  const chunks: Float32Array[] = [];
  for (let start = 0; start < samples.length; start += size) {
    chunks.push(samples.subarray(start, start + size));
  }

  return chunks;
}

/** Decode any browser-playable audio file to 16 kHz mono samples. */
export async function decodeAudioFile(file: File): Promise<Float32Array> {
  // An offline context resamples to its own rate while decoding and, unlike
  // AudioContext, is not blocked by autoplay policy or tied to an output device.
  const context = new OfflineAudioContext(1, 1, VOSK_SAMPLE_RATE);
  const decoded = await context.decodeAudioData(await file.arrayBuffer());
  const channels = Array.from(
    { length: decoded.numberOfChannels },
    (_, index) => decoded.getChannelData(index),
  );

  return mixToMono(channels);
}
