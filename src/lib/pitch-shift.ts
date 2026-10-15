import { fft, hann } from "./fft";

export type PitchShiftOptions = {
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
};

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("变调已取消");
  error.name = "AbortError";
  throw error;
}

function cubicAt(samples: Float32Array, index: number): number {
  const i = Math.floor(index);
  const t = index - i;
  const i0 = Math.max(0, i - 1);
  const i1 = Math.min(samples.length - 1, Math.max(0, i));
  const i2 = Math.min(samples.length - 1, i + 1);
  const i3 = Math.min(samples.length - 1, i + 2);
  const p0 = samples[i0];
  const p1 = samples[i1];
  const p2 = samples[i2];
  const p3 = samples[i3];
  const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const c = -0.5 * p0 + 0.5 * p2;
  return ((a * t + b) * t + c) * t + p1;
}

/** Stretch or squeeze a channel. `outputLength > input.length` lowers the pitch. */
export function resampleCubic(input: Float32Array, outputLength: number): Float32Array {
  const out = new Float32Array(outputLength);
  if (input.length === 0 || outputLength === 0) return out;
  if (outputLength === 1) {
    out[0] = input[0];
    return out;
  }
  const scale = (input.length - 1) / (outputLength - 1);
  for (let i = 0; i < outputLength; i++) {
    out[i] = cubicAt(input, i * scale);
  }
  return out;
}

/** Same curve as `resampleCubic`, but yields so a long export does not freeze the page. */
export async function resampleCubicAsync(
  input: Float32Array,
  outputLength: number,
  options: PitchShiftOptions = {},
): Promise<Float32Array> {
  const out = new Float32Array(outputLength);
  if (input.length === 0 || outputLength === 0) {
    options.onProgress?.(1);
    return out;
  }
  if (outputLength === 1) {
    out[0] = input[0];
    options.onProgress?.(1);
    return out;
  }
  const scale = (input.length - 1) / (outputLength - 1);
  const chunk = 200_000;
  for (let start = 0; start < outputLength; start += chunk) {
    throwIfAborted(options.signal);
    const end = Math.min(outputLength, start + chunk);
    for (let i = start; i < end; i++) out[i] = cubicAt(input, i * scale);
    options.onProgress?.(end / outputLength);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return out;
}

function princarg(phase: number): number {
  return phase - 2 * Math.PI * Math.round(phase / (2 * Math.PI));
}

function chooseFft(length: number): { nfft: number; hop: number } {
  let nfft = 2048;
  while (nfft > length && nfft > 256) nfft >>= 1;
  return { nfft, hop: nfft >> 2 };
}

/**
 * Phase-vocoder time stretch. Pitch stays put; the result is exactly `outputLength` samples.
 */
async function timeStretchToLength(
  input: Float32Array,
  outputLength: number,
  onFrame: (done: number, total: number) => Promise<void>,
): Promise<Float32Array> {
  const { nfft, hop } = chooseFft(Math.max(input.length, outputLength));
  const padded =
    input.length >= nfft ? input : Float32Array.from({ length: nfft }, (_, i) => input[i] ?? 0);

  const window = hann(nfft);
  const frames = Math.floor((padded.length - nfft) / hop) + 1;
  const outStep = frames <= 1 ? 0 : (outputLength - nfft) / (frames - 1);
  const out = new Float64Array(outputLength);
  const norm = new Float64Array(outputLength);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const mag = new Float64Array(nfft / 2 + 1);
  const prevPhase = new Float64Array(nfft / 2 + 1);
  const synthPhase = new Float64Array(nfft / 2 + 1);
  const bins = nfft / 2;

  for (let frame = 0; frame < frames; frame++) {
    if (frame % 24 === 0) await onFrame(frame, frames);
    const start = frame * hop;
    for (let i = 0; i < nfft; i++) {
      re[i] = padded[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im, false);

    for (let k = 0; k <= bins; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      const phase = Math.atan2(im[k], re[k]);
      if (frame === 0) {
        synthPhase[k] = phase;
      } else {
        const expected = (2 * Math.PI * k * hop) / nfft;
        const delta = princarg(phase - prevPhase[k] - expected);
        const advance = (expected + delta) * (outStep / hop);
        synthPhase[k] = princarg(synthPhase[k] + advance);
      }
      prevPhase[k] = phase;
    }

    for (let k = 0; k <= bins; k++) {
      re[k] = mag[k] * Math.cos(synthPhase[k]);
      im[k] = mag[k] * Math.sin(synthPhase[k]);
    }
    for (let k = 1; k < bins; k++) {
      re[nfft - k] = re[k];
      im[nfft - k] = -im[k];
    }
    fft(re, im, true);

    const op = Math.max(0, Math.min(outputLength - nfft, Math.round(frame * outStep)));
    const limit = Math.min(nfft, outputLength - op);
    for (let i = 0; i < limit; i++) {
      const w = window[i];
      out[op + i] += re[i] * w;
      norm[op + i] += w * w;
    }
  }

  const rendered = new Float32Array(outputLength);
  // The Hann tails are nearly zero. Dividing by them turns leftover
  // transform error into spikes, so low-coverage samples stay silent.
  for (let i = 0; i < outputLength; i++) {
    rendered[i] = norm[i] > 0.08 ? out[i] / norm[i] : 0;
  }
  return rendered;
}

function matchPeak(reference: Float32Array, rendered: Float32Array): Float32Array {
  const fade = Math.min(768, Math.floor(rendered.length / 12));
  for (let i = 0; i < fade; i++) {
    const edge = i / fade;
    rendered[i] *= edge;
    rendered[rendered.length - 1 - i] *= edge;
  }

  let inPeak = 0;
  let outPeak = 0;
  const skip = Math.min(fade, Math.floor(rendered.length / 20));
  for (let i = skip; i < reference.length - skip; i++) {
    inPeak = Math.max(inPeak, Math.abs(reference[i]));
  }
  for (let i = skip; i < rendered.length - skip; i++) {
    outPeak = Math.max(outPeak, Math.abs(rendered[i]));
  }
  if (outPeak > 1e-8 && inPeak > 1e-8) {
    const gain = Math.min(inPeak / outPeak, 0.98 / Math.max(outPeak, 1e-8));
    if (Math.abs(gain - 1) > 0.01) {
      for (let i = 0; i < rendered.length; i++) rendered[i] *= gain;
    }
  }
  return rendered;
}

/**
 * Shift pitch by `pitchRatio` (0.9818 lowers 440 Hz to 432 Hz) and keep the duration.
 * Chain: resample to the target pitch, then phase-vocoder the length back.
 */
export async function pitchShiftPreserveDuration(
  channels: Float32Array[],
  pitchRatio: number,
  options: PitchShiftOptions = {},
): Promise<Float32Array[]> {
  if (!Number.isFinite(pitchRatio) || pitchRatio < 0.5 || pitchRatio > 1.5) {
    throw new Error("变调比例超出范围");
  }
  if (Math.abs(pitchRatio - 1) < 0.0015) {
    options.onProgress?.(1);
    return channels.map((channel) => Float32Array.from(channel));
  }

  const outputs: Float32Array[] = [];
  for (let c = 0; c < channels.length; c++) {
    throwIfAborted(options.signal);
    const channel = channels[c];
    const pitchedLength = Math.max(1, Math.round(channel.length / pitchRatio));
    const pitched = resampleCubic(channel, pitchedLength);
    const restored = await timeStretchToLength(pitched, channel.length, async (done, total) => {
      const channelProgress = total === 0 ? 1 : done / total;
      options.onProgress?.((c + channelProgress) / channels.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
      throwIfAborted(options.signal);
    });
    outputs.push(matchPeak(channel, restored));
  }
  options.onProgress?.(1);
  return outputs;
}
