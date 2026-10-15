"use client";

import { useEffect, useRef } from "react";
import { HISTOGRAM_MIN_CENTS } from "@/lib/tuning-math";
import type { Verdict } from "@/lib/tuning-math";

const GAUGE_MIN = 424;
const GAUGE_MAX = 456;

function gaugeX(hz: number, width: number, pad: number) {
  const clamped = Math.min(GAUGE_MAX, Math.max(GAUGE_MIN, hz));
  return pad + ((clamped - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * (width - pad * 2);
}

export function TuningGauge({
  hz,
  tone,
}: {
  hz: number | null;
  tone: Verdict;
}) {
  const width = 640;
  const pad = 28;
  const needle = hz === null ? null : gaugeX(hz, width, pad);
  const mark432 = gaugeX(432, width, pad);
  const mark440 = gaugeX(440, width, pad);
  const needleColor = tone === "432" ? "var(--celadon)" : tone === "440" ? "var(--cinnabar)" : "var(--foreground)";

  const ticks: { hz: number; major: boolean }[] = [];
  for (let value = GAUGE_MIN; value <= GAUGE_MAX; value += 2) {
    ticks.push({ hz: value, major: value % 8 === 0 || value === 432 || value === 440 });
  }

  return (
    <svg viewBox={`0 0 ${width} 108`} className="w-full overflow-visible" role="img" aria-label="基准音刻度">
      <line
        x1={pad}
        x2={width - pad}
        y1="62"
        y2="62"
        stroke="var(--border)"
        strokeWidth="1.5"
      />
      {ticks.map((tick) => {
        const x = gaugeX(tick.hz, width, pad);
        const tall = tick.hz === 432 || tick.hz === 440;
        return (
          <line
            key={tick.hz}
            x1={x}
            x2={x}
            y1={tall ? 46 : tick.major ? 52 : 56}
            y2="62"
            stroke={tick.hz === 432 ? "var(--celadon)" : tick.hz === 440 ? "var(--cinnabar)" : "var(--muted-foreground)"}
            strokeWidth={tall ? 2 : 1}
            opacity={tall ? 1 : 0.55}
          />
        );
      })}
      <text x={mark432} y="84" textAnchor="middle" fill="var(--celadon)" fontSize="13" className="font-figure">
        432
      </text>
      <text x={mark440} y="84" textAnchor="middle" fill="var(--cinnabar)" fontSize="13" className="font-figure">
        440
      </text>
      <text x={pad} y="100" textAnchor="start" fill="var(--muted-foreground)" fontSize="11" className="font-figure">
        Hz
      </text>
      {needle !== null && (
        <g>
          <line x1={needle} x2={needle} y1="16" y2="60" stroke={needleColor} strokeWidth="1.5" />
          <circle cx={needle} cy="14" r="5.5" fill={needleColor} />
        </g>
      )}
    </svg>
  );
}

export function DeviationHistogram({
  weights,
  cents,
}: {
  weights: number[];
  cents: number | null;
}) {
  const max = Math.max(...weights, 1e-9);
  const width = 320;
  const height = 86;
  const barW = width / weights.length;
  const xOf = (value: number) => ((value - HISTOGRAM_MIN_CENTS) / 100) * width;

  return (
    <svg viewBox={`0 0 ${width} ${height + 22}`} className="w-full" role="img" aria-label="音分偏差分布">
      {weights.map((weight, index) => {
        const h = (weight / max) * (height - 8);
        return (
          <rect
            key={index}
            x={index * barW}
            y={height - h}
            width={Math.max(0.6, barW - 0.35)}
            height={h}
            fill="var(--foreground)"
            opacity={0.28 + 0.55 * (weight / max)}
          />
        );
      })}
      <line x1={xOf(-31.77)} x2={xOf(-31.77)} y1="0" y2={height} stroke="var(--celadon)" strokeDasharray="3 3" />
      <line x1={xOf(0)} x2={xOf(0)} y1="0" y2={height} stroke="var(--cinnabar)" strokeDasharray="3 3" />
      {cents !== null && (
        <circle cx={xOf(cents)} cy={8} r="3.5" fill="var(--foreground)" />
      )}
      <text x={xOf(-31.77)} y={height + 16} textAnchor="middle" fill="var(--celadon)" fontSize="11">
        432
      </text>
      <text x={xOf(0)} y={height + 16} textAnchor="middle" fill="var(--cinnabar)" fontSize="11">
        440
      </text>
    </svg>
  );
}

export function Waveform({
  peaks,
  progress,
  accent,
  onSeek,
}: {
  peaks: Float32Array;
  progress: number;
  accent: string;
  onSeek: (ratio: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const mid = height / 2;
      const barW = width / peaks.length;
      let peak = 0;
      for (let i = 0; i < peaks.length; i++) peak = Math.max(peak, peaks[i]);
      const scale = peak > 0 ? (height * 0.42) / peak : 0;
      const played = Math.max(0, Math.min(1, progress)) * peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const h = Math.max(1, peaks[i] * scale);
        ctx.fillStyle = i <= played ? accent : "rgba(42, 36, 30, 0.22)";
        ctx.fillRect(i * barW, mid - h, Math.max(1, barW - 1), h * 2);
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [peaks, progress, accent]);

  const seek = (clientX: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const ratio = rect.width === 0 ? 0 : (clientX - rect.left) / rect.width;
    onSeek(Math.min(1, Math.max(0, ratio)));
  };

  return (
    <div
      ref={wrapRef}
      className="relative h-[76px] cursor-pointer touch-none"
      role="slider"
      aria-label="播放进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        seek(event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) seek(event.clientX);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          onSeek(Math.min(1, progress + 0.02));
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          onSeek(Math.max(0, progress - 0.02));
        }
      }}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
