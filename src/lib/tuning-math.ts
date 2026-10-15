export const A440 = 440;
export const A432 = 432;

/** How far A=432 sits below A=440, in cents. About −31.77. */
export const CENTS_432 = 1200 * Math.log2(A432 / A440);

export const HISTOGRAM_MIN_CENTS = -50;
export const HISTOGRAM_BINS = 101;

export type Verdict = "440" | "432" | "uncertain";

export function centsBetween(fromHz: number, toHz: number): number {
  return 1200 * Math.log2(toHz / fromHz);
}

export function a4FromCents(centsFrom440: number): number {
  return A440 * 2 ** (centsFrom440 / 1200);
}

/**
 * Playback rate that lands the track on A=432.
 * Uncertain detections use the standard 440→432 ratio instead of chasing noise.
 */
export function retuneRate(estimatedA4: number, verdict: Verdict): number {
  if (verdict === "uncertain" || !Number.isFinite(estimatedA4) || estimatedA4 <= 0) {
    return A432 / A440;
  }
  return A432 / estimatedA4;
}

export function formatHz(hz: number): string {
  return hz.toFixed(1);
}

export function formatCents(cents: number): string {
  const rounded = cents.toFixed(1);
  if (cents > 0.05) return `+${rounded}`;
  return rounded;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remain = whole % 60;
  return `${minutes}:${remain.toString().padStart(2, "0")}`;
}
