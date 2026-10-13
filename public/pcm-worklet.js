/**
 * Converts captured audio to signed 16-bit PCM and posts fixed-size frames to
 * the main thread. At 16 kHz a 1024-sample frame is ~64 ms, inside Deepgram's
 * preferred 20-250 ms window.
 *
 * Two modes:
 *   mono   — everything mixed down to one channel (single source)
 *   stereo — channel 0 and channel 1 kept separate and interleaved, so the
 *            transcription service can tell the two speakers apart. Channel 0
 *            is the microphone (you), channel 1 is system audio (them).
 */
class PCMWriter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.frameSize = opts.frameSize || 1024;
    this.stereo = !!opts.stereo;
    this.channels = this.stereo ? 2 : 1;
    this.frame = new Int16Array(this.frameSize * this.channels);
    this.offset = 0;
    this.peak = 0;
    this.peakFar = 0;
  }

  static toPcm(sample) {
    let s = sample;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    return s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const samples = input[0].length;

    for (let i = 0; i < samples; i += 1) {
      if (this.stereo) {
        const near = input[0] ? input[0][i] : 0;
        // A missing second channel means system audio never arrived; write
        // silence rather than duplicating the mic into both channels.
        const far = input[1] ? input[1][i] : 0;

        this.frame[this.offset] = PCMWriter.toPcm(near);
        this.frame[this.offset + 1] = PCMWriter.toPcm(far);
        this.offset += 2;

        const nearMag = near < 0 ? -near : near;
        const farMag = far < 0 ? -far : far;
        if (nearMag > this.peak) this.peak = nearMag;
        if (farMag > this.peakFar) this.peakFar = farMag;
      } else {
        let sum = 0;
        for (let c = 0; c < input.length; c += 1) sum += input[c][i];
        const mixed = sum / input.length;

        this.frame[this.offset] = PCMWriter.toPcm(mixed);
        this.offset += 1;

        const mag = mixed < 0 ? -mixed : mixed;
        if (mag > this.peak) this.peak = mag;
      }

      if (this.offset === this.frame.length) {
        const out = new Int16Array(this.frame);
        this.port.postMessage(
          { pcm: out.buffer, peak: this.peak, peakFar: this.peakFar },
          [out.buffer],
        );
        this.offset = 0;
        this.peak = 0;
        this.peakFar = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-writer', PCMWriter);
