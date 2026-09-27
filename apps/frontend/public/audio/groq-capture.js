/* global AudioWorkletProcessor, registerProcessor */
// Batches 100 ms of mono samples; the call service owns voice activity detection.
class GroqCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1600);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      this.buffer[this.offset++] = sample;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(1600);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("groq-capture", GroqCapture);
