import { fft, hann } from "./fft";
import {
  A440,
  CENTS_432,
  HISTOGRAM_BINS,
  HISTOGRAM_MIN_CENTS,
  a4FromCents,
  type Verdict,
} from "./tuning-math";

export type TuningReason = "ok" | "silence" | "noisy" | "ambiguous" | "off-grid" | "too-short";

export type TuningReport = {
  estimatedA4: number;
  /** Cents relative to A=440. Negative means flat. */
  deviationCents: number;
  centsFrom432: number;
  verdict: Verdict;
  confidence: number;
  confidenceLabel: "高" | "中" | "低";
  /** Share of histogram mass sitting near the winning offset. */
  peakRatio: number;
  /** 101 bins, index 0 = −50 cents, index 50 = 0 cents (A=440). */
  histogram: number[];
  framesUsed: number;
  peaksUsed: number;
  secondsAnalyzed: number;
  reason: TuningReason;
};

export type AnalyzeOptions = {
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
};

const MIN_HZ = 70;
const MAX_HZ = 2400;

function chooseNfft(sampleRate: number): number {
  const target = sampleRate / 2.8;
  let n = 2048;
  while (n < target && n < 16384) n *= 2;
  return n;
}

function frameRms(samples: Float32Array, start: number, length: number): number {
  let sum = 0;
  const stride = length > 4096 ? 2 : 1;
  let count = 0;
  for (let i = 0; i < length; i += stride) {
    const value = samples[start + i];
    sum += value * value;
    count++;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

function pickRegions(totalSamples: number, sampleRate: number): Array<[number, number]> {
  const duration = totalSamples / sampleRate;
  if (duration <= 42) return [[0, totalSamples]];
  const slice = Math.floor(12 * sampleRate);
  return [0.18, 0.5, 0.78].map((center) => {
    const mid = Math.floor(center * totalSamples);
    const start = Math.max(0, mid - Math.floor(slice / 2));
    const end = Math.min(totalSamples, start + slice);
    return [start, end] as [number, number];
  });
}

function parabolicPeak(left: number, center: number, right: number): number {
  const denom = left - 2 * center + right;
  if (Math.abs(denom) < 1e-12) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denom));
}

function smoothHistogram(hist: Float64Array, sigma: number): Float64Array {
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float64Array(radius * 2 + 1);
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] = Math.exp(-0.5 * (i / sigma) ** 2);
  }
  const out = new Float64Array(hist.length);
  for (let i = 0; i < hist.length; i++) {
    let acc = 0;
    let used = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= hist.length) continue;
      const weight = kernel[k + radius];
      acc += hist[j] * weight;
      used += weight;
    }
    out[i] = used > 0 ? acc / used : 0;
  }
  return out;
}

function emptyReport(reason: TuningReason, secondsAnalyzed = 0): TuningReport {
  return {
    estimatedA4: A440,
    deviationCents: 0,
    centsFrom432: -CENTS_432,
    verdict: "uncertain",
    confidence: 0,
    confidenceLabel: "低",
    peakRatio: 0,
    histogram: Array.from({ length: HISTOGRAM_BINS }, () => 0),
    framesUsed: 0,
    peaksUsed: 0,
    secondsAnalyzed,
    reason,
  };
}

function classify(cents: number, peakRatio: number, peaksUsed: number): {
  verdict: Verdict;
  reason: TuningReason;
  confidence: number;
} {
  if (peaksUsed < 12) {
    return { verdict: "uncertain", reason: "silence", confidence: 0.08 };
  }
  if (peakRatio < 0.2) {
    return { verdict: "uncertain", reason: "noisy", confidence: Math.min(0.34, peakRatio) };
  }

  const dist440 = Math.abs(cents);
  const dist432 = Math.abs(cents - CENTS_432);
  const margin = Math.abs(dist440 - dist432);
  const nearest = Math.min(dist440, dist432);

  if (margin < 6) {
    return { verdict: "uncertain", reason: "ambiguous", confidence: 0.36 };
  }
  if (nearest > 14) {
    return {
      verdict: "uncertain",
      reason: "off-grid",
      confidence: Math.min(0.5, 0.25 + peakRatio * 0.3),
    };
  }

  const verdict: Verdict = dist432 < dist440 ? "432" : "440";
  const confidence = Math.max(0, Math.min(1, peakRatio * 1.35 * (1 - nearest / 48)));
  return { verdict, reason: "ok", confidence };
}

function confidenceLabel(confidence: number, verdict: Verdict): "高" | "中" | "低" {
  if (verdict === "uncertain") {
    return confidence >= 0.4 ? "中" : "低";
  }
  if (confidence >= 0.62) return "高";
  if (confidence >= 0.38) return "中";
  return "低";
}

export async function analyzeTuning(
  input: Float32Array,
  sampleRate: number,
  options: AnalyzeOptions = {},
): Promise<TuningReport> {
  if (sampleRate < 8000 || input.length < sampleRate * 0.25) {
    return emptyReport("too-short", input.length / sampleRate);
  }

  const nfft = chooseNfft(sampleRate);
  const hop = nfft >> 2;
  const window = hann(nfft);
  const regions = pickRegions(input.length, sampleRate);
  const starts: number[] = [];
  for (const [start, end] of regions) {
    const regionEnd = Math.min(end, input.length);
    for (let pos = start; pos + nfft <= regionEnd; pos += hop) {
      starts.push(pos);
    }
  }

  if (starts.length === 0) return emptyReport("too-short", input.length / sampleRate);

  const maxFrames = 300;
  let frameStarts = starts;
  if (frameStarts.length > maxFrames) {
    const picked: number[] = [];
    const stride = frameStarts.length / maxFrames;
    for (let i = 0; i < maxFrames; i++) {
      picked.push(frameStarts[Math.floor(i * stride)]);
    }
    frameStarts = picked;
  }

  const rmses = frameStarts.map((start) => frameRms(input, start, nfft));
  const sorted = [...rmses].sort((a, b) => a - b);
  const pivot = sorted[Math.floor(sorted.length * 0.4)] ?? 0;
  const cutoff = Math.max(1e-4, pivot * 0.85);
  const kept = frameStarts.filter((_, index) => rmses[index] >= cutoff);
  if (kept.length === 0) return emptyReport("silence", input.length / sampleRate);

  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const histogram = new Float64Array(HISTOGRAM_BINS);
  const minBin = Math.max(2, Math.ceil((MIN_HZ * nfft) / sampleRate));
  const maxBin = Math.min(nfft / 2 - 2, Math.floor((MAX_HZ * nfft) / sampleRate));
  let peaksUsed = 0;

  for (let frame = 0; frame < kept.length; frame++) {
    if (frame % 20 === 0) {
      options.onProgress?.(frame / kept.length);
      if (options.onProgress) await new Promise((resolve) => setTimeout(resolve, 0));
      if (options.signal?.aborted) {
        const error = new Error("分析已取消");
        error.name = "AbortError";
        throw error;
      }
    }

    const start = kept[frame];
    for (let i = 0; i < nfft; i++) {
      re[i] = input[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im, false);

    let frameMax = 0;
    for (let k = minBin; k <= maxBin; k++) {
      const mag = Math.hypot(re[k], im[k]);
      if (mag > frameMax) frameMax = mag;
    }
    if (frameMax <= 0) continue;
    const floor = frameMax * 0.12;

    const peaks: { mag: number; freq: number }[] = [];
    for (let k = minBin; k <= maxBin; k++) {
      const mag = Math.hypot(re[k], im[k]);
      if (mag < floor) continue;
      const prev = Math.hypot(re[k - 1], im[k - 1]);
      const next = Math.hypot(re[k + 1], im[k + 1]);
      if (mag <= prev || mag < next) continue;
      const delta = parabolicPeak(
        Math.log(prev + 1e-12),
        Math.log(mag + 1e-12),
        Math.log(next + 1e-12),
      );
      const freq = ((k + delta) * sampleRate) / nfft;
      if (freq < MIN_HZ || freq > MAX_HZ) continue;
      peaks.push({ mag, freq });
    }

    peaks.sort((a, b) => b.mag - a.mag);
    const chosen = peaks.slice(0, 6);
    for (const peak of chosen) {
      const semitones = 12 * Math.log2(peak.freq / A440);
      let residual = semitones - Math.round(semitones);
      if (residual >= 0.5) residual -= 1;
      if (residual < -0.5) residual += 1;
      const cents = residual * 100;
      const bin = Math.round(cents - HISTOGRAM_MIN_CENTS);
      if (bin < 0 || bin >= HISTOGRAM_BINS) continue;
      histogram[bin] += peak.mag;
      peaksUsed++;
    }
  }

  options.onProgress?.(1);
  if (peaksUsed === 0) return emptyReport("silence", kept.length * (nfft / sampleRate));

  const smoothed = smoothHistogram(histogram, 1.35);
  let peakIndex = 0;
  for (let i = 1; i < smoothed.length; i++) {
    if (smoothed[i] > smoothed[peakIndex]) peakIndex = i;
  }
  const left = smoothed[Math.max(0, peakIndex - 1)];
  const right = smoothed[Math.min(smoothed.length - 1, peakIndex + 1)];
  const delta = parabolicPeak(left, smoothed[peakIndex], right);
  const deviationCents = peakIndex + delta + HISTOGRAM_MIN_CENTS;

  let mass = 0;
  let near = 0;
  const display = new Array<number>(HISTOGRAM_BINS);
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    display[i] = smoothed[i];
    mass += smoothed[i];
    if (Math.abs(i + HISTOGRAM_MIN_CENTS - deviationCents) <= 6) near += smoothed[i];
  }
  const peakRatio = mass > 0 ? near / mass : 0;
  const estimatedA4 = a4FromCents(deviationCents);
  const judged = classify(deviationCents, peakRatio, peaksUsed);
  let covered = 0;
  for (const [start, end] of regions) covered += Math.max(0, end - start);

  return {
    estimatedA4,
    deviationCents,
    centsFrom432: deviationCents - CENTS_432,
    verdict: judged.verdict,
    confidence: judged.confidence,
    confidenceLabel: confidenceLabel(judged.confidence, judged.verdict),
    peakRatio,
    histogram: display,
    framesUsed: kept.length,
    peaksUsed,
    secondsAnalyzed: Math.min(input.length, covered) / sampleRate,
    reason: judged.reason,
  };
}
