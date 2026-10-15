"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ForkMark } from "@/components/fork-mark";
import { LiveRetune } from "@/components/live-retune";
import { DeviationHistogram, TuningGauge, Waveform } from "@/components/tuning-visuals";
import { analyzeTuning, type TuningReport } from "@/lib/analyze-tuning";
import { makeExample } from "@/lib/examples";
import { pitchShiftPreserveDuration, resampleCubicAsync } from "@/lib/pitch-shift";
import { downloadFileName, encodeWav } from "@/lib/wav";
import {
  CENTS_432,
  formatCents,
  formatHz,
  formatTime,
  retuneRate,
} from "@/lib/tuning-math";
import { copyChannels, mixToMono, waveformPeaks } from "@/lib/waveform";
import { cn } from "@/lib/utils";

type Phase = "empty" | "working" | "ready" | "error";
type PlayMode = "original" | "retuned";

function sliderNumber(value: number | readonly number[]): number {
  return typeof value === "number" ? value : (value[0] ?? 0);
}

function explanation(report: TuningReport): string {
  if (report.verdict === "440") {
    return "音高网格贴近音乐会标准音 A4 = 440 Hz。播放「432 Hz」时，会把测得的基准音移到 432 Hz。";
  }
  if (report.verdict === "432") {
    return "音高网格已经贴近 A4 = 432 Hz。按原曲播放即可，不必再降。";
  }
  if (report.reason === "silence" || report.reason === "too-short") {
    return "清晰的乐音太少，听不出稳定的基准音。可以换一段旋律更清楚的歌曲。";
  }
  if (report.reason === "off-grid") {
    return `最接近的基准音约 ${formatHz(report.estimatedA4)} Hz，离 432 和 440 都比较远。播放「432 Hz」时，会按 440→432 的标准比例下调。`;
  }
  if (report.reason === "ambiguous") {
    return "结果落在 432 Hz 和 440 Hz 正中间，两边都不像。播放「432 Hz」时，会按标准比例下调 31.8 音分。";
  }
  return "音高比较散，没有形成稳定的音格。播放「432 Hz」时，会按 440→432 下调 31.8 音分。";
}

function stampLabel(report: TuningReport): { title: string; caption: string } {
  if (report.verdict === "440") return { title: "440", caption: "440 Hz 调律" };
  if (report.verdict === "432") return { title: "432", caption: "432 Hz 调律" };
  return { title: "未定", caption: "无法判定" };
}

export function TuningBench() {
  const [phase, setPhase] = useState<Phase>("empty");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState("");
  const [report, setReport] = useState<TuningReport | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<PlayMode>("original");
  const [preserveTempo, setPreserveTempo] = useState(false);
  const [volume, setVolume] = useState(0.9);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [downloadNote, setDownloadNote] = useState("");
  const [dragging, setDragging] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const shiftedRef = useRef<{ buffer: AudioBuffer; rate: number } | null>(null);
  const playingRef = useRef(false);
  const offsetRef = useRef(0);
  const startedAtRef = useRef(0);
  const rateRef = useRef(1);
  const modeRef = useRef<PlayMode>("original");
  const preserveRef = useRef(false);
  const reportRef = useRef<TuningReport | null>(null);
  const tokenRef = useRef(0);
  const loadIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const renderAbortRef = useRef<AbortController | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const durationRef = useRef(0);
  const volumeRef = useRef(0.9);
  const renderingRef = useRef(false);
  const onFileRef = useRef<(file: File) => void>(() => {});
  const toggleRef = useRef<() => void>(() => {});

  const stopSource = () => {
    const source = sourceRef.current;
    sourceRef.current = null;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    source.disconnect();
  };

  const ensureContext = () => {
    if (!ctxRef.current) {
      const Ctx = window.AudioContext;
      const ctx = new Ctx();
      const gain = ctx.createGain();
      gain.gain.value = volumeRef.current;
      gain.connect(ctx.destination);
      ctxRef.current = ctx;
      gainRef.current = gain;
    }
    if (ctxRef.current.state === "suspended") void ctxRef.current.resume();
    return ctxRef.current;
  };

  const readPosition = () => {
    const ctx = ctxRef.current;
    if (!playingRef.current || !ctx) return offsetRef.current;
    const next = offsetRef.current + (ctx.currentTime - startedAtRef.current) * rateRef.current;
    return Math.min(durationRef.current, Math.max(0, next));
  };

  const bufferForPlayback = async () => {
    const original = bufferRef.current;
    const current = reportRef.current;
    if (!original) throw new Error("没有可播放的音频");
    if (modeRef.current === "original" || !current) return { buffer: original, rate: 1 };

    const rate = retuneRate(current.estimatedA4, current.verdict);
    if (!preserveRef.current || Math.abs(rate - 1) < 0.0015) {
      return { buffer: original, rate };
    }

    const cached = shiftedRef.current;
    if (cached && Math.abs(cached.rate - rate) < 1e-5) {
      return { buffer: cached.buffer, rate: 1 };
    }

    const ctx = ensureContext();
    renderAbortRef.current?.abort();
    const controller = new AbortController();
    renderAbortRef.current = controller;
    renderingRef.current = true;
    setRenderProgress(0);
    try {
      const shiftedChannels = await pitchShiftPreserveDuration(copyChannels(original), rate, {
        signal: controller.signal,
        onProgress: (value) => {
          setRenderProgress((previous) =>
            previous !== null && Math.abs(previous - value) < 0.015 ? previous : value,
          );
        },
      });
      const shifted = ctx.createBuffer(
        shiftedChannels.length,
        shiftedChannels[0]?.length ?? 0,
        original.sampleRate,
      );
      shiftedChannels.forEach((data, index) => shifted.getChannelData(index).set(data));
      shiftedRef.current = { buffer: shifted, rate };
      return { buffer: shifted, rate: 1 };
    } finally {
      if (renderAbortRef.current === controller) {
        renderingRef.current = false;
        setRenderProgress(null);
      }
    }
  };

  const startAt = async (positionSeconds: number) => {
    const token = ++tokenRef.current;
    const ctx = ensureContext();
    stopSource();
    playingRef.current = false;
    setPlaying(false);
    try {
      const plan = await bufferForPlayback();
      if (token !== tokenRef.current) return;
      const source = ctx.createBufferSource();
      source.buffer = plan.buffer;
      source.playbackRate.value = plan.rate;
      source.connect(gainRef.current ?? ctx.destination);
      const offset = Math.min(
        Math.max(0, positionSeconds),
        Math.max(0, plan.buffer.duration - 0.02),
      );
      source.onended = () => {
        if (sourceRef.current !== source) return;
        playingRef.current = false;
        offsetRef.current = durationRef.current;
        sourceRef.current = null;
        setPlaying(false);
        setPosition(durationRef.current);
      };
      source.start(0, offset);
      sourceRef.current = source;
      offsetRef.current = offset;
      startedAtRef.current = ctx.currentTime;
      rateRef.current = plan.rate;
      playingRef.current = true;
      setPlaying(true);
      setPosition(offset);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "播放失败");
    }
  };

  const pause = () => {
    tokenRef.current += 1;
    renderAbortRef.current?.abort();
    renderingRef.current = false;
    const pos = readPosition();
    stopSource();
    playingRef.current = false;
    offsetRef.current = pos;
    setPlaying(false);
    setPosition(pos);
    setRenderProgress(null);
  };

  const togglePlay = () => {
    if (!bufferRef.current || !reportRef.current) return;
    if (playingRef.current || renderingRef.current) {
      pause();
      return;
    }
    const atEnd = readPosition() >= durationRef.current - 0.05;
    void startAt(atEnd ? 0 : readPosition());
  };

  const seekRatio = (ratio: number) => {
    const next = ratio * durationRef.current;
    if (playingRef.current || renderProgress !== null) void startAt(next);
    else {
      offsetRef.current = next;
      setPosition(next);
    }
  };

  const chooseMode = (next: PlayMode) => {
    const wasPlaying = playingRef.current;
    const pos = readPosition();
    modeRef.current = next;
    setMode(next);
    if (wasPlaying) void startAt(pos);
  };

  const choosePreserve = (next: boolean) => {
    const wasPlaying = playingRef.current && modeRef.current === "retuned";
    const pos = readPosition();
    preserveRef.current = next;
    setPreserveTempo(next);
    if (wasPlaying) void startAt(pos);
  };

  const loadAudioBuffer = async (buffer: AudioBuffer, name: string, loadId: number) => {
    abortRef.current?.abort();
    renderAbortRef.current?.abort();
    downloadAbortRef.current?.abort();
    tokenRef.current += 1;
    stopSource();
    playingRef.current = false;
    shiftedRef.current = null;

    const controller = new AbortController();
    abortRef.current = controller;
    bufferRef.current = buffer;
    durationRef.current = buffer.duration;
    offsetRef.current = 0;
    setDuration(buffer.duration);
    setPosition(0);
    setPlaying(false);
    setFileName(name);
    setDownloadNote("");
    setDownloadProgress(null);
    setReport(null);
    reportRef.current = null;
    setPeaks(null);
    setPhase("working");
    setMessage("正在判断基准音");
    setProgress(0);

    try {
      const mono = mixToMono(buffer);
      if (loadId !== loadIdRef.current) return;
      setPeaks(waveformPeaks(mono, 720));
      const result = await analyzeTuning(mono, buffer.sampleRate, {
        signal: controller.signal,
        onProgress: (value) => {
          setProgress((previous) => (Math.abs(previous - value) < 0.02 ? previous : value));
        },
      });
      if (loadId !== loadIdRef.current || controller.signal.aborted) return;
      reportRef.current = result;
      const nextMode: PlayMode = result.verdict === "440" ? "retuned" : "original";
      modeRef.current = nextMode;
      setMode(nextMode);
      setReport(result);
      setPhase("ready");
      setMessage("");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      if (loadId !== loadIdRef.current) return;
      setPhase("error");
      setMessage("这段音频无法完成判断。");
    }
  };

  const openFile = (file: File) => {
    const loadId = ++loadIdRef.current;
    setPhase("working");
    setMessage("正在读取音频");
    setFileName(file.name.replace(/\.[^.]+$/, "") || file.name);
    setReport(null);
    void (async () => {
      try {
        const ctx = ensureContext();
        const encoded = await file.arrayBuffer();
        if (loadId !== loadIdRef.current) return;
        const audio = await ctx.decodeAudioData(encoded.slice(0));
        if (loadId !== loadIdRef.current) return;
        await loadAudioBuffer(audio, file.name.replace(/\.[^.]+$/, "") || file.name, loadId);
      } catch {
        if (loadId !== loadIdRef.current) return;
        setPhase("error");
        setMessage("这个文件无法解码。请换 MP3、WAV、FLAC、OGG 或 M4A。");
      }
    })();
  };

  const openExample = (a4: 432 | 440) => {
    const loadId = ++loadIdRef.current;
    const name = a4 === 432 ? "432 Hz 示例" : "440 Hz 示例";
    setPhase("working");
    setMessage("正在生成示例");
    setFileName(name);
    setReport(null);
    window.setTimeout(() => {
      if (loadId !== loadIdRef.current) return;
      const ctx = ensureContext();
      const samples = makeExample(a4, 44100);
      const buffer = ctx.createBuffer(1, samples.length, 44100);
      buffer.getChannelData(0).set(samples);
      void loadAudioBuffer(buffer, name, loadId);
    }, 30);
  };

  const pickFile = () => fileInputRef.current?.click();

  const downloadRetuned = async () => {
    const original = bufferRef.current;
    const current = reportRef.current;
    if (!original || !current || downloadAbortRef.current) return;
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    setDownloadProgress(0);
    setDownloadNote("");
    const name = fileName;
    try {
      const rate = retuneRate(current.estimatedA4, current.verdict);
      let channels: Float32Array[];
      if (Math.abs(rate - 1) < 0.0015) {
        channels = copyChannels(original);
        setDownloadProgress(1);
      } else if (preserveRef.current) {
        const cached = shiftedRef.current;
        if (cached && Math.abs(cached.rate - rate) < 1e-5) {
          channels = copyChannels(cached.buffer);
          setDownloadProgress(1);
        } else {
          channels = await pitchShiftPreserveDuration(copyChannels(original), rate, {
            signal: controller.signal,
            onProgress: (value) => {
              setDownloadProgress((previous) =>
                previous !== null && Math.abs(previous - value) < 0.015 ? previous : value,
              );
            },
          });
          if (controller.signal.aborted) return;
          const ctx = ensureContext();
          const shifted = ctx.createBuffer(
            channels.length,
            channels[0]?.length ?? 0,
            original.sampleRate,
          );
          channels.forEach((data, index) => shifted.getChannelData(index).set(data));
          shiftedRef.current = { buffer: shifted, rate };
        }
      } else {
        const outLength = Math.max(1, Math.round(original.length / rate));
        const count = original.numberOfChannels;
        channels = [];
        for (let c = 0; c < count; c++) {
          const rendered = await resampleCubicAsync(original.getChannelData(c), outLength, {
            signal: controller.signal,
            onProgress: (value) => {
              const next = (c + value) / count;
              setDownloadProgress((previous) =>
                previous !== null && Math.abs(previous - next) < 0.015 ? previous : next,
              );
            },
          });
          channels.push(rendered);
        }
      }
      if (controller.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const wav = encodeWav(channels, original.sampleRate);
      const blob = new Blob([wav], { type: "audio/wav" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = downloadFileName(name);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 4000);
      const saved = window.yinchaDesktop ? "文件在电脑的「下载」文件夹里。" : "";
      if (Math.abs(rate - 1) < 0.0015) {
        setDownloadNote(`已经接近 432 Hz，文件按原音高保存。${saved}`);
      } else if (preserveRef.current) {
        setDownloadNote(`已开始下载。音高是 432 Hz，长度和原曲一样。${saved}`);
      } else {
        setDownloadNote(`已开始下载。用任何播放器打开都是 432 Hz。${saved}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setDownloadNote(error instanceof Error ? error.message : "下载失败");
    } finally {
      if (downloadAbortRef.current === controller) {
        downloadAbortRef.current = null;
        setDownloadProgress(null);
      }
    }
  };

  useEffect(() => {
    volumeRef.current = volume;
    modeRef.current = mode;
    preserveRef.current = preserveTempo;
    reportRef.current = report;
    toggleRef.current = togglePlay;
    onFileRef.current = openFile;
  });

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = volume;
  }, [volume]);

  useEffect(() => {
    let frame = 0;
    let last = 0;
    const tick = (time: number) => {
      if (time - last > 80 && playingRef.current) {
        last = time;
        setPosition(readPosition());
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (!bufferRef.current) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let depth = 0;
    const hasFile = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (event: DragEvent) => {
      if (!hasFile(event)) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (!hasFile(event)) return;
      event.preventDefault();
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFile(event)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFile(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) onFileRef.current(file);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    return () => {
      tokenRef.current += 1;
      abortRef.current?.abort();
      renderAbortRef.current?.abort();
      downloadAbortRef.current?.abort();
      stopSource();
      void ctxRef.current?.close();
    };
  }, []);

  const tonal =
    report !== null &&
    report.peaksUsed > 0 &&
    report.reason !== "silence" &&
    report.reason !== "too-short";
  const rate = report ? retuneRate(report.estimatedA4, report.verdict) : 432 / 440;
  const shiftCents = 1200 * Math.log2(rate);
  const wallClock =
    mode === "retuned" && !preserveTempo && report ? duration / rate : duration;
  const accent = mode === "retuned" ? "#1f7a62" : "#a33b28";
  const stamp = report ? stampLabel(report) : null;

  const playbackNote = (() => {
    if (!report) return "";
    if (Math.abs(shiftCents) < 3) return "和 432 Hz 已经很接近，播放时几乎不再移动音高。";
    const centsText = `${formatCents(shiftCents)} 音分`;
    if (preserveTempo) return `音高移动 ${centsText}，歌曲长度保持不变。`;
    const speed = Math.abs(rate - 1) * 100;
    const direction = rate < 1 ? "放慢" : "加快";
    return `音高移动 ${centsText}，速度一并${direction} ${speed.toFixed(1)}%。这样没有变调算法的痕迹。`;
  })();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 py-8 md:px-8 md:py-12">
      <header className="flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-3 text-foreground">
            <ForkMark className="size-10 text-cinnabar" />
            <h1 className="font-figure text-4xl leading-none tracking-tight md:text-5xl">音叉</h1>
          </div>
          <p className="mt-4 max-w-xl text-[15px] leading-7 text-muted-foreground">
            上传一首歌，判断基准音更接近 432 Hz 还是 440 Hz。如果是 440 Hz，就转成 432 Hz
            播放或下载。也可以对着正在响的声音实时降频。
          </p>
        </div>
        <p className="hidden max-w-40 text-right text-xs leading-5 text-muted-foreground sm:block">
          音频只在这台设备上分析，不会上传。
        </p>
      </header>

      <div className="mt-8 flex flex-1 flex-col">
        {phase === "empty" && (
          <section
            className={cn(
              "sheet flex flex-1 flex-col items-center justify-center rounded-[28px] px-6 py-16 text-center",
              dragging && "ring-2 ring-cinnabar",
            )}
          >
            <ForkMark className="size-16 text-foreground/80" />
            <h2 className="mt-6 font-figure text-3xl tracking-tight">把歌曲放在这里</h2>
            <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
              支持 MP3、WAV、FLAC、OGG、M4A。也可以先听一段已知音高的示例，看判断准不准。
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button type="button" size="lg" className="h-11 rounded-full px-5" onClick={pickFile}>
                选择歌曲
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-11 rounded-full px-5"
                onClick={() => openExample(440)}
              >
                440 Hz 示例
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-11 rounded-full px-5"
                onClick={() => openExample(432)}
              >
                432 Hz 示例
              </Button>
            </div>
          </section>
        )}

        {phase === "working" && (
          <section className="sheet rounded-[28px] px-6 py-10 md:px-10">
            <p className="text-xs tracking-[0.18em] text-muted-foreground">正在听</p>
            <h2 className="mt-2 truncate font-figure text-3xl">{fileName}</h2>
            <p className="mt-4 text-sm text-muted-foreground">{message}</p>
            <div className="mt-6 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-foreground transition-[width] duration-300"
                style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }}
              />
            </div>
          </section>
        )}

        {phase === "error" && (
          <section className="sheet rounded-[28px] px-6 py-10 md:px-10" role="alert">
            <h2 className="font-figure text-3xl">没有听成</h2>
            <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">{message}</p>
            <Button type="button" className="mt-6 h-11 rounded-full px-5" onClick={pickFile}>
              另选一首
            </Button>
          </section>
        )}

        {phase === "ready" && report && stamp && (
          <section className="sheet rounded-[28px] px-5 py-6 md:px-8 md:py-8">
            <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
              <div className="min-w-0">
                <p className="text-xs tracking-[0.18em] text-muted-foreground">曲目</p>
                <h2 className="mt-1 truncate text-xl">{fileName}</h2>
              </div>
              <Button type="button" variant="ghost" className="shrink-0 rounded-full" onClick={pickFile}>
                换一首
              </Button>
            </div>

            <div className="mt-6 grid items-start gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
              <div>
                <div className="flex items-end justify-between gap-4">
                  <div
                    className={cn(
                      "grid size-[88px] place-items-center rounded-2xl border",
                      report.verdict === "440" && "border-transparent bg-cinnabar text-white",
                      report.verdict === "432" && "border-transparent bg-celadon text-white",
                      report.verdict === "uncertain" && "border-foreground/20 text-foreground",
                    )}
                    aria-label={stamp.caption}
                  >
                    <span className="font-figure text-3xl leading-none">{stamp.title}</span>
                  </div>
                  <p className="text-right text-sm text-muted-foreground">{stamp.caption}</p>
                </div>

                <p className="mt-8 text-xs tracking-[0.16em] text-muted-foreground">测得基准音</p>
                <p className="mt-1 flex items-end gap-2">
                  <span className="font-figure text-6xl leading-none tracking-tight md:text-7xl">
                    {tonal ? formatHz(report.estimatedA4) : "—"}
                  </span>
                  <span className="mb-1 text-sm text-muted-foreground">Hz</span>
                </p>

                <dl className="mt-6 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">相对 440</dt>
                    <dd
                      className={cn(
                        "mt-1 font-figure text-2xl",
                        report.verdict === "440" && "text-cinnabar",
                      )}
                    >
                      {tonal ? formatCents(report.deviationCents) : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">相对 432</dt>
                    <dd
                      className={cn(
                        "mt-1 font-figure text-2xl",
                        report.verdict === "432" && "text-celadon",
                      )}
                    >
                      {tonal ? formatCents(report.centsFrom432) : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">置信度</dt>
                    <dd className="mt-1 font-figure text-2xl">{report.confidenceLabel}</dd>
                  </div>
                </dl>

                <div className="mt-6">
                  <TuningGauge hz={tonal ? report.estimatedA4 : null} tone={report.verdict} />
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{explanation(report)}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {report.secondsAnalyzed > duration * 0.9
                    ? `整段 ${formatTime(duration)} 都参与了判断。`
                    : `从其中约 ${Math.max(1, Math.round(report.secondsAnalyzed))} 秒较清楚的片段判断。`}
                  {report.verdict === "440" ? " 已选好 432 Hz 播放，按空格即可对比。" : " 空格键播放或暂停。"}
                </p>
              </div>

              <div className="lg:border-l lg:border-border lg:pl-8">
                <p className="text-xs tracking-[0.16em] text-muted-foreground">试听</p>
                <div className="mt-3 grid grid-cols-2 gap-1 rounded-full bg-muted p-1">
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={mode === "original"}
                    className={cn(
                      "h-10 rounded-full",
                      mode === "original" && "bg-primary text-primary-foreground hover:bg-primary/90",
                    )}
                    onClick={() => chooseMode("original")}
                  >
                    原曲
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={mode === "retuned"}
                    className={cn(
                      "h-10 rounded-full",
                      mode === "retuned" && "bg-celadon text-white hover:bg-celadon/90",
                    )}
                    onClick={() => chooseMode("retuned")}
                  >
                    432 Hz
                  </Button>
                </div>

                <label className="mt-5 flex items-center justify-between gap-4 text-sm">
                  <span>
                    <span className="block">保持原速</span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {playbackNote}
                    </span>
                  </span>
                  <Switch
                    checked={preserveTempo}
                    onCheckedChange={choosePreserve}
                    aria-label="保持原速"
                  />
                </label>

                <div className="mt-6 flex items-center gap-4">
                  <Button
                    type="button"
                    size="icon-lg"
                    className="size-14 rounded-full"
                    onClick={togglePlay}
                    aria-label={playing ? "暂停" : mode === "retuned" ? "播放 432 Hz" : "播放原曲"}
                  >
                    {renderProgress !== null ? (
                      <Loader2 className="size-5 animate-spin" />
                    ) : playing ? (
                      <Pause className="size-5" />
                    ) : (
                      <Play className="size-5 translate-x-px" />
                    )}
                  </Button>
                  <div className="min-w-0 flex-1">
                    <p className="font-figure text-lg tabular-nums">
                      {formatTime(position)}
                      <span className="text-muted-foreground"> / {formatTime(duration)}</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {renderProgress !== null
                        ? `正在转换音高 ${Math.round(renderProgress * 100)}%`
                        : mode === "retuned" && !preserveTempo && Math.abs(rate - 1) > 0.002
                          ? `听完大约需要 ${formatTime(wallClock)}`
                          : mode === "retuned"
                            ? "正在按 432 Hz 播放"
                            : "正在听原曲"}
                    </p>
                  </div>
                </div>

                <div className="mt-4 border-y border-border py-2">
                  {peaks && (
                    <Waveform
                      peaks={peaks}
                      progress={duration > 0 ? position / duration : 0}
                      accent={accent}
                      onSeek={seekRatio}
                    />
                  )}
                </div>

                <label className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="w-8 shrink-0">音量</span>
                  <Slider
                    aria-label="音量"
                    min={0}
                    max={1}
                    step={0.01}
                    value={[volume]}
                    onValueChange={(value) => setVolume(sliderNumber(value))}
                  />
                </label>

                <Button
                  type="button"
                  variant="outline"
                  className="mt-5 h-10 w-full rounded-full"
                  disabled={downloadProgress !== null || renderProgress !== null}
                  onClick={() => void downloadRetuned()}
                >
                  {downloadProgress !== null
                    ? `正在准备 ${Math.round(downloadProgress * 100)}%`
                    : "下载 432 Hz"}
                </Button>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {downloadNote ||
                    (Math.abs(rate - 1) < 0.0015
                      ? "测得的音高已经接近 432 Hz，下载的 WAV 不再移动音高。"
                      : preserveTempo
                        ? "保存成 WAV：只移动音高，歌曲长度不变。"
                        : "保存成 WAV：音高和速度一起放进采样，用任何播放器打开都是 432 Hz。")}
                </p>

                <div className="mt-6">
                  <p className="text-xs tracking-[0.16em] text-muted-foreground">音分分布</p>
                  <div className="mt-2">
                    <DeviationHistogram
                      weights={report.histogram}
                      cents={tonal ? report.deviationCents : null}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>

      <LiveRetune />

      <footer className="mt-8 grid gap-2 text-sm leading-6 text-muted-foreground md:grid-cols-[auto_1fr] md:gap-6">
        <p className="font-figure text-base text-foreground">怎么判断</p>
        <p>
          找出较清晰的音，看它们离十二平均律的音格有多远。全体偏低约 {Math.abs(CENTS_432).toFixed(0)}{" "}
          音分，就是 432 Hz；几乎不偏，就是 440 Hz。这大约是半音的三分之一，听得出来，但不会听成另一个音。
        </p>
      </footer>

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,.aiff,.aif,.webm"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) openFile(file);
        }}
      />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-[oklch(0.94_0.02_86/0.9)]">
          <p className="font-figure text-4xl tracking-tight">松开，开始判断</p>
        </div>
      )}
    </div>
  );
}
