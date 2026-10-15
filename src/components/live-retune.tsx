"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { analyzeTuning, type TuningReport } from "@/lib/analyze-tuning";
import { workletSource } from "@/lib/live-pitch";
import { CENTS_432, formatCents, formatHz, retuneRate } from "@/lib/tuning-math";
import { cn } from "@/lib/utils";

const LISTEN_SECONDS = 8;
const GLOBAL_RATIO = 432 / 440;

type SourceKind = "mic" | "display";
type LivePhase = "idle" | "listening" | "shifting" | "error";

type Engine = {
  id: number;
  pass: number;
  ctx: AudioContext;
  stream: MediaStream;
  input: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  gain: GainNode;
  url: string;
  source: SourceKind;
  chunks: Float32Array[];
  captured: number;
  target: number;
  capturing: boolean;
  busy: boolean;
  lastUi: number;
  global: boolean;
};

function release(engine: Engine) {
  engine.capturing = false;
  engine.busy = true;
  for (const track of engine.stream.getTracks()) track.onended = null;
  engine.stream.getTracks().forEach((track) => track.stop());
  engine.node.port.onmessage = null;
  try {
    engine.input.disconnect();
  } catch {
    /* already stopped */
  }
  try {
    engine.node.disconnect();
  } catch {
    /* already stopped */
  }
  try {
    engine.gain.disconnect();
  } catch {
    /* already stopped */
  }
  void engine.ctx.close().catch(() => undefined);
  URL.revokeObjectURL(engine.url);
}

function liveRatio(report: TuningReport): number {
  if (report.verdict === "432") return 1;
  const rate = retuneRate(report.estimatedA4, report.verdict);
  if (!Number.isFinite(rate)) return 432 / 440;
  return Math.min(1.5, Math.max(0.5, rate));
}

function describeShift(report: TuningReport, ratio: number): string {
  if (ratio === 1) {
    return `这 ${LISTEN_SECONDS} 秒测得基准音 ${formatHz(report.estimatedA4)} Hz，已经贴近 432 Hz，按原音高播放。`;
  }
  const cents = 1200 * Math.log2(ratio);
  if (report.verdict === "uncertain") {
    return `这 ${LISTEN_SECONDS} 秒没有形成稳定音格，按标准比例降低 ${formatCents(Math.abs(cents)).replace("+", "")} 音分。`;
  }
  return `测得基准音 ${formatHz(report.estimatedA4)} Hz，正在降到 432 Hz（${formatCents(cents)} 音分）。`;
}

function friendlyError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "没有获得权限。麦克风需要点允许；分享时要勾选标签页音频或系统音频。";
    }
    if (error.name === "NotFoundError") return "没有找到可用的输入设备。";
    if (error.name === "NotReadableError") return "这个设备正被别的程序占用。";
    if (error.name === "AbortError") return "请求被取消了。";
  }
  if (error instanceof Error && error.message) return error.message;
  return "实时降频没有启动。";
}

async function captureMic(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("这个浏览器不能使用麦克风。请改用 Chrome 或 Edge。");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false,
  });
}

async function captureDisplay(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("这个浏览器不能分享电脑里的声音。请改用 Chrome 或 Edge。");
  }
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    suppressLocalAudioPlayback: true,
    ...(window.yinchaDesktop ? { restrictOwnAudio: true } : {}),
  } as MediaTrackConstraints;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio,
  });
  stream.getVideoTracks().forEach((track) => track.stop());
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("没有拿到声音。分享时请勾选标签页音频或系统音频。");
  }
  return stream;
}

export function LiveRetune() {
  const [source, setSource] = useState<SourceKind>("mic");
  const [headphones, setHeadphones] = useState(false);
  const [phase, setPhase] = useState<LivePhase>("idle");
  const [status, setStatus] = useState("");
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(0);
  const [report, setReport] = useState<TuningReport | null>(null);
  const [globalMode, setGlobalMode] = useState(false);
  const desktopPlatform = useSyncExternalStore(
    () => () => {},
    () => window.yinchaDesktop?.platform ?? "",
    () => "",
  );

  const engineRef = useRef<Engine | null>(null);
  const sessionRef = useRef(0);
  const headphonesRef = useRef(false);
  const sourceRef = useRef<SourceKind>("mic");

  const applyGain = (engine: Engine) => {
    const audible = engine.source === "display" || headphonesRef.current;
    engine.gain.gain.value = audible ? 1 : 0;
  };

  const stop = (message?: string) => {
    sessionRef.current += 1;
    const engine = engineRef.current;
    engineRef.current = null;
    if (engine) release(engine);
    setLevel(0);
    setHeard(0);
    setReport(null);
    setGlobalMode(false);
    if (message) {
      setPhase("error");
      setStatus(message);
      return;
    }
    setPhase("idle");
    setStatus("");
  };

  useEffect(() => {
    headphonesRef.current = headphones;
    sourceRef.current = source;
    const engine = engineRef.current;
    if (engine) applyGain(engine);
  });

  useEffect(() => {
    return () => {
      sessionRef.current += 1;
      const engine = engineRef.current;
      engineRef.current = null;
      if (engine) release(engine);
    };
  }, []);

  const finish = async (engine: Engine) => {
    const pass = engine.pass;
    const id = engine.id;
    setStatus("正在判断基准音");
    const length = Math.min(engine.captured, engine.target);
    const merged = new Float32Array(length);
    let offset = 0;
    for (const chunk of engine.chunks) {
      const take = Math.min(chunk.length, length - offset);
      if (take <= 0) break;
      merged.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
      offset += take;
    }
    engine.chunks = [];
    try {
      const result = await analyzeTuning(merged, engine.ctx.sampleRate);
      if (engineRef.current !== engine || engine.pass !== pass || sessionRef.current !== id) return;
      const ratio = liveRatio(result);
      engine.node.port.postMessage({ ratio });
      engine.busy = false;
      setReport(result);
      setPhase("shifting");
      setStatus(describeShift(result, ratio));
      applyGain(engine);
    } catch (error) {
      if (engineRef.current !== engine || sessionRef.current !== id) return;
      engine.busy = false;
      if (error instanceof Error && error.name === "AbortError") return;
      stop("这几秒没能判断出基准音。可以再听一次。");
    }
  };

  const begin = async (kind: SourceKind, global = false) => {
    if (engineRef.current) return;
    if (kind === "mic" && !headphonesRef.current) return;
    const id = sessionRef.current + 1;
    sessionRef.current = id;
    setGlobalMode(global);
    setPhase(global ? "shifting" : "listening");
    setReport(null);
    setHeard(0);
    setLevel(0);
    setStatus(global ? "正在接管电脑里的声音" : kind === "mic" ? "正在请求麦克风" : "正在请求要分享的声音");

    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let url = "";
    try {
      stream = kind === "mic" ? await captureMic() : await captureDisplay();
      if (sessionRef.current !== id) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const AudioCtx = window.AudioContext;
      ctx = new AudioCtx();
      await ctx.resume();
      if (!ctx.audioWorklet) {
        throw new Error("这个浏览器没有实时音频处理。请改用 Chrome 或 Edge。");
      }
      const blob = new Blob([workletSource()], { type: "application/javascript" });
      url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      if (sessionRef.current !== id) {
        stream.getTracks().forEach((track) => track.stop());
        URL.revokeObjectURL(url);
        void ctx.close();
        return;
      }

      const input = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "yincha-live-pitch");
      const gain = ctx.createGain();
      gain.gain.value = kind === "display" || headphonesRef.current ? 1 : 0;
      node.port.postMessage({ capture: !global, ratio: global ? GLOBAL_RATIO : 1 });
      input.connect(node);
      node.connect(gain);
      gain.connect(ctx.destination);

      const engine: Engine = {
        id,
        pass: 1,
        ctx,
        stream,
        input,
        node,
        gain,
        url,
        source: kind,
        chunks: [],
        captured: 0,
        target: Math.round(LISTEN_SECONDS * ctx.sampleRate),
        capturing: !global,
        busy: false,
        lastUi: 0,
        global,
      };
      engineRef.current = engine;
      node.port.onmessage = (event: MessageEvent<{ rms?: number; samples?: Float32Array }>) => {
        const current = engineRef.current;
        if (current !== engine) return;
        const data = event.data;
        const now = performance.now();
        if (typeof data?.rms === "number" && now - current.lastUi > 80) {
          current.lastUi = now;
          setLevel(Math.min(1, data.rms * 3.2));
          if (current.capturing) setHeard(current.captured / current.ctx.sampleRate);
        }
        if (!current.capturing || !data?.samples || current.busy) return;
        current.chunks.push(data.samples);
        current.captured += data.samples.length;
        if (current.captured < current.target) return;
        current.capturing = false;
        current.busy = true;
        current.node.port.postMessage({ capture: false });
        void finish(current);
      };
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          if (engineRef.current !== engine) return;
          stop("声音中断了。");
        };
      }
      setStatus(
        global
          ? "正在把 440 Hz 降到 432 Hz。只有一路声音，不会叠出混响。"
          : `正在听，大约 ${LISTEN_SECONDS} 秒后开始降频`,
      );
    } catch (error) {
      setGlobalMode(false);
      stream?.getTracks().forEach((track) => track.stop());
      if (url) URL.revokeObjectURL(url);
      if (ctx) void ctx.close().catch(() => undefined);
      if (sessionRef.current !== id) return;
      setPhase("error");
      setStatus(friendlyError(error));
      setLevel(0);
    }
  };

  const rejudge = () => {
    const engine = engineRef.current;
    if (!engine || engine.busy || engine.global) return;
    engine.pass += 1;
    engine.chunks = [];
    engine.captured = 0;
    engine.capturing = true;
    engine.node.port.postMessage({ capture: true });
    setReport(null);
    setHeard(0);
    setPhase("listening");
    setStatus("再听 8 秒，确认基准音");
  };

  const running = phase === "listening" || phase === "shifting";
  const remain = Math.max(0, Math.ceil(LISTEN_SECONDS - heard));
  const shiftCents = report ? 1200 * Math.log2(liveRatio(report)) : 0;

  return (
    <section className="sheet mt-8 rounded-[28px] px-5 py-6 md:px-8 md:py-8">
      <p className="text-xs tracking-[0.16em] text-muted-foreground">听歌</p>
      <h2 className="mt-2 font-figure text-3xl tracking-tight">整台电脑降到 432 Hz</h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        流行歌大多按 440 Hz 调音。打开后立刻降到 432 Hz，不用先听 8
        秒。播放中只有一路声音，不会把延迟的复制叠上去，所以没有那种混响。
      </p>
      {!running && (
        <Button
          type="button"
          className="mt-5 h-11 rounded-full px-5"
          onClick={() => {
            setSource("display");
            void begin("display", true);
          }}
        >
          全局降到 432 Hz
        </Button>
      )}

      <p className="mt-8 text-xs tracking-[0.16em] text-muted-foreground">也可以先听 8 秒再判断</p>
      <div className="mt-3 grid grid-cols-2 gap-1 rounded-full bg-muted p-1 sm:max-w-md">
        <Button
          type="button"
          variant="ghost"
          aria-pressed={source === "mic"}
          disabled={running}
          className={cn(
            "h-10 rounded-full",
            source === "mic" && "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
          onClick={() => setSource("mic")}
        >
          用麦克风听
        </Button>
        <Button
          type="button"
          variant="ghost"
          aria-pressed={source === "display"}
          disabled={running}
          className={cn(
            "h-10 rounded-full",
            source === "display" && "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
          onClick={() => setSource("display")}
        >
          听电脑正在放的声音
        </Button>
      </div>

      {source === "mic" && (
        <label className="mt-5 flex items-center justify-between gap-4 text-sm sm:max-w-md">
          <span>
            <span className="block">我戴着耳机</span>
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
              麦克风打开后，声音只送到耳机。扬声器播放会造成啸叫。
            </span>
          </span>
          <Switch
            checked={headphones}
            onCheckedChange={setHeadphones}
            aria-label="我戴着耳机"
          />
        </label>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {!running && (
          <Button
            type="button"
            className="h-11 rounded-full px-5"
            disabled={source === "mic" && !headphones}
            onClick={() => void begin(sourceRef.current)}
          >
            {phase === "error" ? "再试一次" : "开始"}
          </Button>
        )}
        {running && (
          <>
            <Button type="button" variant="outline" className="h-11 rounded-full px-5" onClick={() => stop()}>
              停止
            </Button>
            {phase === "shifting" && !globalMode && (
              <Button type="button" variant="outline" className="h-11 rounded-full px-5" onClick={rejudge}>
                重新判断
              </Button>
            )}
          </>
        )}
      </div>

      <div className="mt-5 max-w-md" aria-hidden={phase === "idle"}>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-celadon transition-[width] duration-150"
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
          {phase === "listening" && status.includes("判断")
            ? status
            : phase === "listening" && heard > 0
              ? `正在听，还要约 ${remain} 秒`
              : status || "电平会在开始后出现。"}
        </p>
      </div>

      {phase === "shifting" && globalMode && (
        <p className="mt-4 font-figure text-2xl tracking-tight">
          440
          <span className="mx-2 text-sm text-muted-foreground">→</span>
          432 Hz
        </p>
      )}

      {phase === "shifting" && report && (
        <p className="mt-4 font-figure text-2xl tracking-tight">
          {Math.abs(shiftCents) < 3 ? "432 Hz" : formatHz(report.estimatedA4)}
          <span className="ml-2 text-sm text-muted-foreground">
            {Math.abs(shiftCents) < 3 ? "保持原音高" : "Hz → 432 Hz"}
          </span>
        </p>
      )}

      <div className="mt-6 max-w-2xl space-y-2 text-sm leading-6 text-muted-foreground">
        {desktopPlatform === "win32" ? (
          <p>
            这个 Windows 程序可以直接听电脑正在播放的声音，不用安装虚拟声卡。请先戴上耳机，再点「听电脑正在放的声音」。原来的播放会安静下来，你听到的是这里降频后的声音。点「停止」后恢复。标准的
            440→432 大约是 {Math.abs(CENTS_432).toFixed(1)} 音分。
          </p>
        ) : (
          <>
            <p>
              听电脑正在放的声音时，用 Chrome 或 Edge 分享标签页并勾选音频，或分享整个屏幕并带上系统音频。macOS
              经常拿不到系统音频，需要下面的虚拟声卡。
            </p>
            <p>
              整台电脑（网易云、Spotify、浏览器以外的程序）：把系统播放设到虚拟声卡，再选「用麦克风听」并选那条虚拟输入。Windows
              可以用 VB-CABLE，macOS 可以用 BlackHole。请戴耳机。标准的 440→432 大约是 {Math.abs(CENTS_432).toFixed(1)}{" "}
              音分。
            </p>
          </>
        )}
      </div>
    </section>
  );
}
