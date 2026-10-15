import { describe, expect, it } from "vitest";
import { LivePitchShifter, workletSource } from "../src/lib/live-pitch";
import { resampleCubic, resampleCubicAsync } from "../src/lib/pitch-shift";
import { downloadFileName, encodeWav } from "../src/lib/wav";

const SR = 44100;

function sineFreq(samples: Float32Array, sampleRate: number): number {
  const start = Math.min(4000, Math.floor(samples.length * 0.15));
  const end = Math.max(start + 10, samples.length - Math.floor(samples.length * 0.05));
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

function tone(freq: number, frames: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

function runBlocks(shifter: LivePitchShifter, input: Float32Array, block = 128): Float32Array {
  const output = new Float32Array(input.length);
  const scratchIn = new Float32Array(block);
  const scratchOut = new Float32Array(block);
  for (let offset = 0; offset < input.length; offset += block) {
    const count = Math.min(block, input.length - offset);
    scratchIn.set(input.subarray(offset, offset + count));
    if (count < block) scratchIn.fill(0, count);
    shifter.process([scratchIn.subarray(0, count)], [scratchOut.subarray(0, count)]);
    output.set(scratchOut.subarray(0, count), offset);
  }
  return output;
}

describe("wav export", () => {
  it("writes a 16-bit stereo header and round-trips samples", () => {
    const left = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const right = Float32Array.from([0.25, -0.25, 0, 2, -2]);
    const wav = encodeWav([left, right], 44100);
    const view = new DataView(wav);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe(
      "RIFF",
    );
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe(
      "WAVE",
    );
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(left.length * 4);

    const read = (frame: number, channel: number) => view.getInt16(44 + (frame * 2 + channel) * 2, true) / 32768;
    expect(read(1, 0)).toBeCloseTo(0.5, 2);
    expect(read(2, 0)).toBeCloseTo(-0.5, 2);
    expect(read(1, 1)).toBeCloseTo(-0.25, 2);
    expect(view.getInt16(44 + (3 * 2 + 1) * 2, true)).toBe(32767);
    expect(view.getInt16(44 + (4 * 2 + 1) * 2, true)).toBe(-32768);
  });

  it("builds a safe 432 Hz file name", () => {
    expect(downloadFileName('a/b:c*?"<>| song')).toBe("a b c song-432Hz.wav");
    expect(downloadFileName("   ")).toBe("歌曲-432Hz.wav");
  });

  it("matches the synchronous resampler", async () => {
    const input = tone(440, 5000);
    const sync = resampleCubic(input, 5200);
    const asyncOut = await resampleCubicAsync(input, 5200);
    expect(asyncOut.length).toBe(sync.length);
    for (let i = 0; i < sync.length; i += 50) expect(asyncOut[i]).toBeCloseTo(sync[i], 5);
  });
});

describe("live pitch shifter", () => {
  it("copies audio when the ratio is 1", () => {
    const shifter = new LivePitchShifter(2048);
    const input = tone(440, 4096);
    const output = runBlocks(shifter, input);
    for (let i = 0; i < input.length; i++) expect(output[i]).toBeCloseTo(input[i], 5);
  });

  it("drops a 440 Hz sine to about 432 Hz", () => {
    const grain = 8192;
    const shifter = new LivePitchShifter(grain);
    shifter.ratio = 432 / 440;
    const input = tone(440, SR * 2);
    const output = runBlocks(shifter, input);
    const freq = sineFreq(output.subarray(grain), SR);
    expect(Math.abs(freq - 432)).toBeLessThan(1.5);
    let energy = 0;
    const region = output.subarray(grain, grain + SR);
    for (let i = 0; i < region.length; i++) energy += region[i] * region[i];
    expect(energy / region.length).toBeGreaterThan(0.2);
  });

  it("keeps shifting after a stretch of unmodified listening", () => {
    const grain = 8192;
    const shifter = new LivePitchShifter(grain);
    const lead = tone(440, SR);
    const leadOut = runBlocks(shifter, lead);
    expect(leadOut[1000]).toBeCloseTo(lead[1000], 5);
    shifter.ratio = 432 / 440;
    const rest = tone(440, SR * 2);
    const output = runBlocks(shifter, rest);
    const freq = sineFreq(output.subarray(grain), SR);
    expect(Math.abs(freq - 432)).toBeLessThan(1.5);
  });

  it("does not stack a delayed copy into the sound", () => {
    const shifter = new LivePitchShifter(8192);
    shifter.ratio = 432 / 440;
    const input = new Float32Array(SR);
    input[1000] = 1;
    const output = runBlocks(shifter, input);
    let peaks = 0;
    for (let i = 0; i < output.length; i++) if (Math.abs(output[i]) > 0.2) peaks += 1;
    expect(peaks).toBeGreaterThan(0);
    expect(peaks).toBeLessThan(6);
    let echo = 0;
    for (let i = 4000; i < 7000; i++) echo += output[i] * output[i];
    expect(echo).toBe(0);
  });

  it("stays near 432 Hz across a splice", () => {
    const shifter = new LivePitchShifter(512);
    shifter.ratio = 432 / 440;
    const input = tone(440, SR * 3);
    const output = runBlocks(shifter, input);
    const freq = sineFreq(output.subarray(SR * 2), SR);
    expect(Math.abs(freq - 432)).toBeLessThan(1.5);
  });
    it("stringifies into a worklet module", () => {
    const source = workletSource();
    expect(source).toContain("registerProcessor");
    expect(source).toContain("yincha-live-pitch");
    expect(source).not.toContain("import ");
    const ctor = new Function(`${LivePitchShifter.toString()}; return ${LivePitchShifter.name};`)() as new (
      grain?: number,
    ) => LivePitchShifter;
    const shifter = new ctor(1024);
    shifter.ratio = 1;
    const input = new Float32Array([0.2, -0.2, 0.2, -0.2]);
    const output = new Float32Array(4);
    shifter.process([input], [output]);
    expect(Array.from(output)).toEqual(Array.from(input));
  });
});
