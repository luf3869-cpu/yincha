import { describe, expect, it } from "vitest";
import { fft } from "../src/lib/fft";
import { analyzeTuning } from "../src/lib/analyze-tuning";
import { makeExample, sineWave } from "../src/lib/examples";
import { pitchShiftPreserveDuration, resampleCubic } from "../src/lib/pitch-shift";
import { A432, A440, CENTS_432, retuneRate } from "../src/lib/tuning-math";

const SR = 44100;

function reportText(hz: number, extra?: unknown) {
  return JSON.stringify(extra);
}

function sineFreq(samples: Float32Array, sampleRate: number): number {
  const start = Math.min(4000, Math.floor(samples.length * 0.2));
  const end = Math.max(start + 10, samples.length - start);
  let first = -1;
  let last = -1;
  let crossings = 0;
  for (let i = start + 1; i < end; i++) {
    if (samples[i - 1] <= 0 && samples[i] > 0) {
      const frac = samples[i - 1] / (samples[i - 1] - samples[i]);
      const pos = i - 1 + frac;
      if (first < 0) first = pos;
      last = pos;
      crossings++;
    }
  }
  if (crossings < 4) return Number.NaN;
  return ((crossings - 1) * sampleRate) / (last - first);
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function majorChord(a4: number, seconds = 3): Float32Array {
  const length = Math.floor(seconds * SR);
  const samples = new Float32Array(length);
  for (const semitone of [0, 4, 7]) {
    const freq = a4 * 2 ** (semitone / 12);
    for (let h = 1; h <= 5; h++) {
      const amp = 1 / h;
      for (let i = 0; i < length; i++) {
        samples[i] += amp * Math.sin((2 * Math.PI * freq * h * i) / SR);
      }
    }
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const gain = 0.7 / peak;
  for (let i = 0; i < length; i++) samples[i] *= gain;
  return samples;
}

describe("fft", () => {
  it("round-trips a real buffer", () => {
    const re = new Float64Array([1, -2, 0.5, 3, 0, 1, -1, 0.25]);
    const im = new Float64Array(re.length);
    const original = Float64Array.from(re);
    fft(re, im, false);
    fft(re, im, true);
    for (let i = 0; i < re.length; i++) {
      expect(re[i]).toBeCloseTo(original[i], 8);
      expect(im[i]).toBeCloseTo(0, 8);
    }
  });

  it("places a bin-centered cosine on that bin", () => {
    const n = 64;
    const bin = 5;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / n);
    fft(re, im, false);
    let peak = 1;
    for (let k = 2; k < n / 2; k++) {
      if (Math.hypot(re[k], im[k]) > Math.hypot(re[peak], im[peak])) peak = k;
    }
    expect(peak).toBe(bin);
  });
});

describe("tuning detector", () => {
  it("hears a 440 Hz tone as 440", async () => {
    const report = await analyzeTuning(sineWave(440, 3), SR);
    expect(report.verdict, reportText(report.estimatedA4, report)).toBe("440");
    expect(Math.abs(report.estimatedA4 - 440)).toBeLessThan(1);
    expect(report.confidenceLabel).not.toBe("低");
  });

  it("hears a 432 Hz tone as 432", async () => {
    const report = await analyzeTuning(sineWave(432, 3), SR);
    expect(report.verdict, reportText(report.estimatedA4, report)).toBe("432");
    expect(Math.abs(report.estimatedA4 - 432)).toBeLessThan(1);
  });

  it("hears an A-major chord in both standards", async () => {
    const at440 = await analyzeTuning(majorChord(440), SR);
    const at432 = await analyzeTuning(majorChord(432), SR);
    expect(at440.verdict, reportText(at440.estimatedA4, at440)).toBe("440");
    expect(at432.verdict, reportText(at432.estimatedA4, at432)).toBe("432");
    expect(Math.abs(at440.estimatedA4 - 440)).toBeLessThan(1.5);
    expect(Math.abs(at432.estimatedA4 - 432)).toBeLessThan(1.5);
  });

  it("classifies the built-in examples", async () => {
    const at440 = await analyzeTuning(makeExample(440), SR);
    const at432 = await analyzeTuning(makeExample(432), SR);
    expect(at440.verdict, reportText(at440.estimatedA4, at440)).toBe("440");
    expect(at432.verdict, reportText(at432.estimatedA4, at432)).toBe("432");
  });

  it("treats a slightly flat 440 recording as 440, not 432", async () => {
    const report = await analyzeTuning(sineWave(438, 3), SR);
    expect(report.verdict, reportText(report.estimatedA4, report)).toBe("440");
    expect(Math.abs(report.estimatedA4 - 438)).toBeLessThan(1.5);
  });

  it("refuses the midpoint and off-grid pitches", async () => {
    const middle = await analyzeTuning(sineWave(436, 3), SR);
    const sharp = await analyzeTuning(sineWave(446, 3), SR);
    expect(middle.verdict, reportText(middle.estimatedA4, middle)).toBe("uncertain");
    expect(sharp.verdict, reportText(sharp.estimatedA4, sharp)).toBe("uncertain");
    expect(Math.abs(middle.estimatedA4 - 436)).toBeLessThan(1.5);
    expect(Math.abs(sharp.estimatedA4 - 446)).toBeLessThan(1.5);
  });

  it("does not invent a tuning for silence or noise", async () => {
    const silence = await analyzeTuning(new Float32Array(SR * 2), SR);
    expect(silence.verdict).toBe("uncertain");
    expect(silence.reason).toBe("silence");

    const rng = mulberry32(7);
    const noise = new Float32Array(SR * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = rng() * 2 - 1;
    const noisy = await analyzeTuning(noise, SR);
    expect(noisy.verdict, reportText(noisy.estimatedA4, noisy)).toBe("uncertain");
  });

  it("still hears 440 under light noise", async () => {
    const chord = majorChord(440, 3);
    const rng = mulberry32(11);
    for (let i = 0; i < chord.length; i++) chord[i] = chord[i] * 0.9 + (rng() * 2 - 1) * 0.04;
    const report = await analyzeTuning(chord, SR);
    expect(report.verdict, reportText(report.estimatedA4, report)).toBe("440");
  });
});

describe("432 playback", () => {
  it("uses the standard ratio when the verdict is uncertain", () => {
    expect(retuneRate(450, "uncertain")).toBeCloseTo(A432 / A440, 8);
    expect(retuneRate(441, "440")).toBeCloseTo(432 / 441, 8);
    expect(CENTS_432).toBeGreaterThan(-33);
    expect(CENTS_432).toBeLessThan(-30);
  });

  it("resamples 440 Hz down to 432 Hz", () => {
    const input = sineWave(440, 2);
    const ratio = 432 / 440;
    const lowered = resampleCubic(input, Math.round(input.length / ratio));
    const freq = sineFreq(lowered, SR);
    expect(Math.abs(freq - 432)).toBeLessThan(0.4);
  });

  it("keeps a chord's tuning when the duration stays put", async () => {
    const chord = majorChord(440, 2);
    const [shifted] = await pitchShiftPreserveDuration([chord], 432 / 440);
    const report = await analyzeTuning(shifted, SR);
    expect(report.verdict, JSON.stringify({ hz: report.estimatedA4, cents: report.deviationCents })).toBe(
      "432",
    );
    expect(Math.abs(report.estimatedA4 - 432)).toBeLessThan(2);
  });

  it("keeps the duration while moving 440 Hz to 432 Hz", async () => {
    const input = sineWave(440, 2);
    const [shifted] = await pitchShiftPreserveDuration([input], 432 / 440);
    expect(shifted.length).toBe(input.length);
    const freq = sineFreq(shifted, SR);
    expect(Math.abs(freq - 432)).toBeLessThan(1.5);
    let inEnergy = 0;
    let outEnergy = 0;
    for (let i = 0; i < input.length; i++) {
      inEnergy += input[i] * input[i];
      outEnergy += shifted[i] * shifted[i];
    }
    expect(outEnergy).toBeGreaterThan(inEnergy * 0.25);
    expect(outEnergy).toBeLessThan(inEnergy * 2.5);
  });
});
