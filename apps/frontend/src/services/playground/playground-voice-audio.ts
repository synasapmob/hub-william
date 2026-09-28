export const VOICE_SPEECH_PROBABILITY = 0.5;
// Visual meter/native-call activity only; local transcription is gated by VAD.
export const VOICE_ACTIVITY_THRESHOLD = 0.015;

export function voiceSampleLevel(frame: Float32Array): number {
  if (!frame.length) return 0;
  return Math.sqrt(
    frame.reduce((sum, value) => sum + value * value, 0) / frame.length,
  );
}

// The AudioWorklet sends mono 16 kHz PCM in 100 ms frames.
export class PlaygroundVoiceActivity {
  private frames: Float32Array[] = [];
  private preroll: Float32Array[] = [];
  private silent = 0;
  private voiced = 0;

  get active(): boolean {
    return this.voiced >= 2;
  }

  snapshot(): Float32Array {
    return this.join(this.frames);
  }

  reset() {
    this.frames = [];
    this.preroll = [];
    this.silent = 0;
    this.voiced = 0;
  }

  push(frame: Float32Array, probability: number): Float32Array | null {
    const speech = probability >= VOICE_SPEECH_PROBABILITY;
    if (!this.frames.length && !speech) {
      this.preroll = [...this.preroll.slice(-2), frame];
      return null;
    }
    if (!this.frames.length) this.frames = this.preroll;
    this.frames.push(frame);
    this.silent = speech ? 0 : this.silent + 1;
    if (speech) this.voiced += 1;
    if (this.silent < 20 && this.frames.length < 200) return null;
    const frames = this.frames;
    const voiced = this.voiced;
    this.reset();
    if (voiced < 2) return null;
    return this.join(frames);
  }

  private join(frames: Float32Array[]): Float32Array {
    const samples = new Float32Array(
      frames.reduce((sum, item) => sum + item.length, 0),
    );
    let offset = 0;
    for (const item of frames) {
      samples.set(item, offset);
      offset += item.length;
    }
    return samples;
  }
}
