import { voiceSampleLevel } from "./playground-voice-audio";

interface PlaygroundVoiceMeterChannel {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  onLevel: (level: number) => void;
}

export default class PlaygroundVoiceMeter {
  private context = new AudioContext();
  private channels: PlaygroundVoiceMeterChannel[] = [];
  private timer: number;
  private closing: Promise<void> | null = null;

  constructor() {
    this.timer = window.setInterval(() => {
      for (const channel of this.channels) {
        channel.analyser.getFloatTimeDomainData(channel.samples);
        channel.onLevel(voiceSampleLevel(channel.samples));
      }
    }, 100);
  }

  async resume() {
    await this.context.resume();
  }

  observe(stream: MediaStream, onLevel: (level: number) => void) {
    if (this.closing) return;
    const source = this.context.createMediaStreamSource(stream);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    // No connection to destination: metering must never play the mic back.
    this.channels.push({
      source,
      analyser,
      samples: new Float32Array(analyser.fftSize),
      onLevel,
    });
  }

  end(): Promise<void> {
    if (this.closing) return this.closing;
    window.clearInterval(this.timer);
    for (const channel of this.channels) {
      channel.source.disconnect();
      channel.analyser.disconnect();
      channel.onLevel(0);
    }
    this.channels = [];
    this.closing = this.context.close();
    return this.closing;
  }
}
