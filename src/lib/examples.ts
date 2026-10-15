/** A short A-major figure tuned to the given A4, used to check the detector. */
export function makeExample(a4: number, sampleRate = 44100): Float32Array {
  const seconds = 8;
  const length = Math.floor(seconds * sampleRate);
  const samples = new Float32Array(length);
  const melody = [57, 61, 64, 69, 64, 61, 59, 57];
  const noteDur = seconds / melody.length;
  const harmonicAmps = [1, 0.52, 0.3, 0.16, 0.09, 0.05];

  for (let note = 0; note < melody.length; note++) {
    const freq = a4 * 2 ** ((melody[note] - 69) / 12);
    const start = Math.floor(note * noteDur * sampleRate);
    const end = Math.min(length, Math.floor((note + 1) * noteDur * sampleRate));
    for (let i = start; i < end; i++) {
      const t = (i - start) / sampleRate;
      const env = Math.min(1, t * 90) * Math.exp(-2.8 * t);
      let sum = 0;
      for (let h = 0; h < harmonicAmps.length; h++) {
        sum += harmonicAmps[h] * Math.sin(2 * Math.PI * freq * (h + 1) * t);
      }
      samples[i] += sum * env * 0.16;
    }
  }

  const bass = a4 * 2 ** ((45 - 69) / 12);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const env = 0.72 + 0.28 * Math.sin(2 * Math.PI * 0.25 * t);
    samples[i] +=
      0.07 *
      env *
      (Math.sin(2 * Math.PI * bass * t) +
        0.35 * Math.sin(2 * Math.PI * bass * 2 * t) +
        0.16 * Math.sin(2 * Math.PI * bass * 3 * t));
  }

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const gain = peak > 0 ? 0.78 / peak : 1;
  for (let i = 0; i < length; i++) samples[i] *= gain;
  return samples;
}

export function sineWave(
  freq: number,
  seconds: number,
  sampleRate = 44100,
  harmonics: number[] = [1],
): Float32Array {
  const length = Math.floor(seconds * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let sum = 0;
    for (const h of harmonics) sum += Math.sin(2 * Math.PI * freq * h * t) / h;
    samples[i] = sum / harmonics.length;
  }
  return samples;
}
