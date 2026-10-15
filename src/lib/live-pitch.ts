/**
 * Real-time pitch shifter with one read head.
 *
 * The head moves at `ratio`, so 432/440 lowers 440 Hz to 432 Hz. Most of the
 * time a single sample is played, which does not stack a delayed copy into
 * reverb. When the head falls too far behind, it jumps forward under a short
 * crossfade. `ratio === 1` copies the input.
 *
 * The class is copied into an AudioWorklet by `toString()`. It must not close
 * over imports, and it must not use private fields.
 */
export class LivePitchShifter {
  grain: number;
  maxDelay: number;
  minDelay: number;
  fadeLength: number;
  bufferSize: number;
  ratio: number;
  writePos: number;
  readPos: number;
  fadeLeft: number;
  fadeFrom: number;
  buffers: Float32Array[];

  constructor(grain?: number) {
    const requested = typeof grain === "number" && grain >= 32 ? grain | 0 : 8192;
    this.grain = requested;
    this.maxDelay = requested > 4096 ? 2048 : requested;
    this.minDelay = this.maxDelay >> 3;
    if (this.minDelay < 32) this.minDelay = 32;
    if (this.minDelay > this.maxDelay >> 1) this.minDelay = this.maxDelay >> 1;
    const span = this.maxDelay - this.minDelay;
    this.fadeLength = span > 64 ? Math.min(384, span >> 1) : 16;
    let size = 1024;
    while (size < this.maxDelay * 4) size <<= 1;
    this.bufferSize = size;
    this.ratio = 1;
    this.writePos = 0;
    this.readPos = 0;
    this.fadeLeft = 0;
    this.fadeFrom = 0;
    this.buffers = [];
  }

  readAt(buffer: Float32Array, position: number): number {
    const length = this.bufferSize;
    const mask = length - 1;
    let index = position % length;
    if (index < 0) index += length;
    const i0 = index | 0;
    const frac = index - i0;
    const i1 = (i0 + 1) & mask;
    return buffer[i0] * (1 - frac) + buffer[i1] * frac;
  }

  process(input: ArrayLike<Float32Array>, output: ArrayLike<Float32Array>): void {
    const inputs = input.length;
    const outputs = output.length;
    if (inputs === 0 || outputs === 0) return;
    const frames = input[0] ? input[0].length : 0;
    if (frames === 0) return;

    while (this.buffers.length < inputs) {
      this.buffers.push(new Float32Array(this.bufferSize));
    }

    let ratio = this.ratio;
    if (!(ratio >= 0.5 && ratio <= 1.5)) ratio = 1;
    const unity = ratio > 0.9995 && ratio < 1.0005;
    const length = this.bufferSize;
    const maxDelay = this.maxDelay;
    const jump = maxDelay - this.minDelay;
    const fadeLength = this.fadeLength;
    let writePos = this.writePos;
    let readPos = this.readPos;
    let fadeLeft = this.fadeLeft;
    let fadeFrom = this.fadeFrom;

    for (let i = 0; i < frames; i++) {
      const slot = writePos % length;
      for (let c = 0; c < inputs; c++) this.buffers[c][slot] = input[c][i];

      if (unity) {
        for (let c = 0; c < outputs; c++) output[c][i] = input[c < inputs ? c : 0][i];
        readPos = writePos;
        fadeLeft = 0;
      } else {
        if (fadeLeft <= 0 && writePos - readPos >= maxDelay) {
          fadeFrom = readPos;
          fadeLeft = fadeLength;
          readPos += jump;
        }
        let mixed = false;
        let wOld = 0;
        let wNew = 1;
        let oldPos = 0;
        if (fadeLeft > 0) {
          const t = fadeLeft / fadeLength;
          wOld = Math.sin(t * 1.5707963267948966);
          wNew = Math.cos(t * 1.5707963267948966);
          oldPos = fadeFrom;
          fadeFrom += ratio;
          fadeLeft -= 1;
          mixed = true;
        }
        for (let c = 0; c < outputs; c++) {
          const source = c < inputs ? c : 0;
          const buffer = this.buffers[source];
          const shifted = this.readAt(buffer, readPos);
          output[c][i] = mixed ? wOld * this.readAt(buffer, oldPos) + wNew * shifted : shifted;
        }
        readPos += ratio;
      }

      writePos += 1;
    }

    this.writePos = writePos;
    this.readPos = readPos;
    this.fadeLeft = fadeLeft;
    this.fadeFrom = fadeFrom;
  }
}

/** Script for `audioWorklet.addModule`. The class name survives minification. */
export function workletSource(): string {
  const ctorName = LivePitchShifter.name;
  return `${LivePitchShifter.toString()}
const YinchaPitchShifter = ${ctorName};
class YinchaLivePitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.shifter = new YinchaPitchShifter(8192);
    this.capture = true;
    this.tick = 0;
    this.mix = new Float32Array(128);
    const processor = this;
    this.port.onmessage = function (event) {
      const data = event.data || {};
      if (typeof data.ratio === "number" && data.ratio === data.ratio) {
        processor.shifter.ratio = data.ratio;
      }
      if (typeof data.capture === "boolean") processor.capture = data.capture;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length || !input[0]) return true;
    const frames = input[0].length;
    this.shifter.process(input, output);
    if (this.mix.length < frames) this.mix = new Float32Array(frames);
    let energy = 0;
    const channels = input.length;
    const mix = this.mix;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += input[c][i];
      const sample = sum / channels;
      mix[i] = sample;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / frames);
    this.tick = (this.tick + 1) | 0;
    if (this.capture) {
      const samples = new Float32Array(frames);
      samples.set(mix.subarray(0, frames));
      this.port.postMessage({ rms: rms, samples: samples }, [samples.buffer]);
    } else if ((this.tick & 3) === 0) {
      this.port.postMessage({ rms: rms });
    }
    return true;
  }
}
registerProcessor("yincha-live-pitch", YinchaLivePitchProcessor);
`;
}
