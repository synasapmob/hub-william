interface PlaygroundGroqPlaybackOptions {
  context: AudioContext;
  recordingOutput: AudioNode | null;
  signal: AbortSignal;
  onPhase: (phase: "thinking" | "speaking") => void;
  onError: (error: unknown) => void;
}

/** Per-turn predecode and scheduling; text delivery never waits for playback. */
export default class PlaygroundGroqPlayback {
  private options: PlaygroundGroqPlaybackOptions;
  private encoded: string[] = [];
  private ready: AudioBuffer[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private decoding = false;
  private ended = false;
  private stopped = false;
  private buffering = true;
  private nextStart = 0;
  private encodedBytes = 0;
  private decodedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolve!: () => void;
  private drained = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });

  constructor(options: PlaygroundGroqPlaybackOptions) {
    this.options = options;
    options.signal.addEventListener("abort", this.stop, { once: true });
    if (options.signal.aborted) this.stop();
  }

  append(audio: string) {
    if (this.stopped || this.ended) return;
    this.encodedBytes += audio.length;
    if (this.encodedBytes > 6 * 1024 * 1024) {
      this.fail(new Error("Groq returned oversized voice audio."));
      return;
    }
    this.encoded.push(audio);
    void this.decode();
  }

  complete() {
    this.ended = true;
    this.schedule();
    this.settle();
    return this.drained;
  }

  stop = () => {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.options.signal.removeEventListener("abort", this.stop);
    this.encoded = [];
    this.ready = [];
    for (const node of this.sources) {
      node.onended = null;
      node.stop();
      node.disconnect();
    }
    this.sources.clear();
    this.resolve();
  };

  private fail(error: unknown) {
    if (this.stopped) return;
    this.stop();
    this.options.onError(error);
  }

  private async decode() {
    if (this.decoding || this.stopped) return;
    this.decoding = true;
    try {
      while (!this.stopped && this.encoded.length && this.ready.length < 2) {
        const bytes = Uint8Array.from(atob(this.encoded.shift()!), (value) =>
          value.charCodeAt(0),
        );
        const buffer = await this.options.context.decodeAudioData(bytes.buffer);
        if (this.stopped) return;
        this.decodedBytes += buffer.length * buffer.numberOfChannels * 4;
        if (
          !Number.isFinite(buffer.duration) ||
          buffer.duration <= 0 ||
          this.decodedBytes > 64 * 1024 * 1024
        )
          throw new Error("Groq returned invalid voice audio.");
        await this.options.context.resume();
        if (this.stopped) return;
        this.ready.push(buffer);
        this.schedule();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.decoding = false;
      this.schedule();
      this.settle();
    }
  }

  private schedule() {
    if (this.stopped || !this.ready.length) return;
    if (this.buffering) {
      const final = this.ended && !this.encoded.length && !this.decoding;
      if (this.ready.length < 2 && !final) {
        // A short/slow reply must not wait indefinitely for a second chunk.
        this.timer ??= setTimeout(() => {
          this.timer = undefined;
          this.buffering = false;
          this.schedule();
        }, 1200);
        return;
      }
      this.buffering = false;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    const { context, recordingOutput, onPhase } = this.options;
    while (this.ready.length && this.sources.size < 2) {
      const buffer = this.ready.shift()!;
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      if (recordingOutput) node.connect(recordingOutput);
      this.sources.add(node);
      node.onended = () => {
        this.sources.delete(node);
        node.disconnect();
        if (this.stopped) return;
        if (!this.sources.size && !this.ready.length) {
          this.buffering = true;
          onPhase("thinking");
        }
        this.schedule();
        void this.decode();
        this.settle();
      };
      // Schedule against the audio clock, not the previous node's JS onended.
      const when = Math.max(context.currentTime + 0.02, this.nextStart);
      this.nextStart = when + buffer.duration;
      node.start(when);
      onPhase("speaking");
    }
  }

  private settle() {
    if (
      this.ended &&
      !this.decoding &&
      !this.encoded.length &&
      !this.ready.length &&
      !this.sources.size
    ) {
      clearTimeout(this.timer);
      this.options.signal.removeEventListener("abort", this.stop);
      this.resolve();
    }
  }
}
