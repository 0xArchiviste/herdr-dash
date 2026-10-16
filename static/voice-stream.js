// herdr-dash local voice stream: an AudioWorklet processor that cuts the
// microphone's 16 kHz mono float frames into 100 ms chunks for the
// /api/voice/stream WebSocket. The context's sample rate must be 16 kHz
// (new AudioContext({ sampleRate: 16000 })); the browser resamples.
class PCMStream extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600); // 100 ms at 16 kHz
    this.n = 0;
  }
  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;
    let i = 0;
    while (i < input.length) {
      const take = Math.min(input.length - i, this.buf.length - this.n);
      this.buf.set(input.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-stream", PCMStream);
