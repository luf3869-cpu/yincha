"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { analyzeTuning, type TuningReport } from "@/lib/analyze-tuning";
import { pickCableOutput } from "@/lib/cable-device";
import { workletSource } from "@/lib/live-pitch";
import { formatCents, formatHz, retuneRate } from "@/lib/tuning-math";
import { cn } from "@/lib/utils";

const LISTEN_SECONDS = 8;
const RELISTEN_MS = 3 * 60 * 1000;
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
  audible: boolean;
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

async function captureMic(requireCable = false): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("这个浏览器不能使用麦克风。请改用 Chrome 或 Edge。");
  }
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  const probe = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  try {
    const cable = pickCableOutput(await navigator.mediaDevices.enumerateDevices());
    if (!cable?.deviceId) {
      if (requireCable) {
        probe.getTracks().forEach((track) => track.stop());
        throw new Error("没有找到 CABLE Output。请先安装 VB-CABLE，重启电脑后再试。");
      }
      return probe;
    }
    const routed = await navigator.mediaDevices.getUserMedia({
      audio: { ...audio, deviceId: { exact: cable.deviceId } },
      video: false,
    });
    probe.getTracks().forEach((track) => track.stop());
    return routed;
  } catch (error) {
    if (requireCable) {
      probe.getTracks().forEach((track) => track.stop());
      throw error;
    }
    return probe;
  }
}

async function routeOutput(ctx: AudioContext, prefer: "speakers" | "headphones"): Promise<boolean> {
  const sink = ctx as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
  if (typeof sink.setSinkId !== "function") return false;
  const outputs = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "audiooutput" && device.deviceId,
  );
  const avoid = /cable|vb-?audio|todesk|voicemeeter|virtual/i;
  const want = prefer === "headphones" ? /耳机|headphone|headset/i : /扬声器|speaker/i;
  const match =
    outputs.find((device) => want.test(device.label) && !avoid.test(device.label)) ||
    outputs.find((device) => device.deviceId !== "default" && device.deviceId !== "communications" && !avoid.test(device.label));
  if (!match) return false;
  await sink.setSinkId(match.deviceId);
  return true;
}

async function captureDisplay(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("这个浏览器不能分享电脑里的声音。请改用 Chrome 或 Edge。");
  }
  const desktop = Boolean(window.yinchaDesktop);
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    // On the desktop app this flag mutes the playback device, so the shifted audio goes silent.
    suppressLocalAudioPlayback: !desktop,
    ...(desktop ? { restrictOwnAudio: true } : {}),
  } as MediaTrackConstraints;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio,
  });
  stream.getVideoTracks().forEach((track) => {
    if (desktop) track.enabled = false;
    else track.stop();
  });
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("没有拿到声音。分享时请勾选标签页音频或系统音频。");
  }
  return stream;
}

export function LiveRetune() {
  const [source, setSource] = useState<SourceKind>("mic");
  const [output, setOutput] = useState<"speakers" | "headphones">("speakers");
  const [headphones, setHeadphones] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const armRef = useRef(false);
  const outputRef = useRef(output);
  const headphonesRef = useRef(false);
  const sourceRef = useRef<SourceKind>("mic");
  const phaseRef = useRef<LivePhase>("idle");
  const rejudgeRef = useRef<(reason?: string) => boolean>(() => false);

  const applyGain = (engine: Engine) => {
    engine.gain.gain.value = engine.audible || engine.source === "display" || headphonesRef.current ? 1 : 0;
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
    outputRef.current = output;
    sourceRef.current = source;
    phaseRef.current = phase;
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

  const begin = async (
    kind: SourceKind,
    global = false,
    options?: { requireCable?: boolean; audible?: boolean; routeOutput?: "speakers" | "headphones" },
  ) => {
    if (engineRef.current) return false;
    if (kind === "mic" && !options?.audible && !headphonesRef.current) return false;
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
      stream = kind === "mic" ? await captureMic(options?.requireCable) : await captureDisplay();
      if (sessionRef.current !== id) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      const AudioCtx = window.AudioContext;
      ctx = new AudioCtx();
      await ctx.resume();
      if (options?.routeOutput) {
        const routed = await routeOutput(ctx, options.routeOutput);
        if (!routed) throw new Error("声音还停在虚拟声卡上，已停下，避免回授卡死。");
      }
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
        return false;
      }

      const input = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "yincha-live-pitch");
      const gain = ctx.createGain();
      const audible = options?.audible || kind === "display" || headphonesRef.current;
      gain.gain.value = audible ? 1 : 0;
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
        audible,
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
      const desktop = Boolean(window.yinchaDesktop);
      setStatus(
        global
          ? desktop
            ? "正在把 440 Hz 降到 432 Hz。原来的声音还会响，会和降频叠在一起。"
            : "正在把 440 Hz 降到 432 Hz。只有一路声音，不会叠出混响。"
          : `正在听，大约 ${LISTEN_SECONDS} 秒后开始降频`,
      );
    } catch (error) {
      setGlobalMode(false);
      stream?.getTracks().forEach((track) => track.stop());
      if (url) URL.revokeObjectURL(url);
      if (ctx) void ctx.close().catch(() => undefined);
      if (sessionRef.current !== id) return false;
      setPhase("error");
      setStatus(friendlyError(error));
      setLevel(0);
      return false;
    }
    return true;
  };

  const runOnce = async (task: () => Promise<void>) => {
    if (armRef.current || engineRef.current) return;
    armRef.current = true;
    setBusy(true);
    try {
      await task();
    } finally {
      armRef.current = false;
      setBusy(false);
    }
  };

  const startDesktop = () =>
    runOnce(async () => {
      setPhase("listening");
      setStatus(outputRef.current === "speakers" ? "正在接到外放…" : "正在接到耳机…");
      try {
        const routed = await window.yinchaDesktop?.setupCable?.(outputRef.current);
        if (!routed?.ok) {
          setPhase("error");
          setStatus(routed?.error || "没有接上虚拟声卡。");
          return;
        }
        const started = await begin("mic", false, {
          requireCable: true,
          audible: true,
          routeOutput: outputRef.current,
        });
        if (!started) await window.yinchaDesktop?.restoreAudio?.();
      } catch (error) {
        setPhase("error");
        setStatus(error instanceof Error ? error.message : "没有开始。");
        await window.yinchaDesktop?.restoreAudio?.();
      }
    });

  const stopDesktop = async () => {
    if (armRef.current) return;
    armRef.current = true;
    setBusy(true);
    try {
      stop();
      setStatus("正在把播放器放回原来的设备…");
      const restored = await window.yinchaDesktop?.restoreAudio?.();
      if (restored && restored.ok === false) {
        setPhase("error");
        setStatus(restored.error || "播放器还没放回去，请再点一次停止。");
        return;
      }
      setPhase("idle");
      setStatus(restored?.restored ? "已停止，播放器回到原来的设备。" : "已停止。");
    } finally {
      armRef.current = false;
      setBusy(false);
    }
  };

  const rejudge = (reason?: string) => {
    const engine = engineRef.current;
    if (!engine || engine.busy || engine.capturing) return false;
    engine.pass += 1;
    engine.chunks = [];
    engine.captured = 0;
    engine.capturing = true;
    engine.node.port.postMessage({ capture: true });
    setReport(null);
    setHeard(0);
    setPhase("listening");
    setStatus(reason || "再听 8 秒，按新测得基准音调整");
    return true;
  };
  rejudgeRef.current = rejudge;

  useEffect(() => {
    if (!window.yinchaDesktop || phase !== "shifting") return;
    const timer = window.setInterval(() => {
      if (phaseRef.current === "shifting") rejudgeRef.current("每 3 分钟自动再听，个性化调整频率");
    }, RELISTEN_MS);
    const unsubscribe = window.yinchaDesktop.onSongChange?.((song) => {
      if (phaseRef.current !== "shifting") return;
      const who = song.process === "QQMusic" ? "QQ音乐" : song.process === "msedge" ? "Edge" : "播放器";
      rejudgeRef.current(`${who}切歌：${song.title}，重新听 8 秒`);
    });
    void window.yinchaDesktop.watchSongs?.(true);
    return () => {
      window.clearInterval(timer);
      unsubscribe?.();
      void window.yinchaDesktop?.watchSongs?.(false);
    };
  }, [phase]);

  const running = phase === "listening" || phase === "shifting";
  const remain = Math.max(0, Math.ceil(LISTEN_SECONDS - heard));
  const shiftCents = report ? 1200 * Math.log2(liveRatio(report)) : 0;

  const desktop = desktopPlatform === "win32";

  return (
    <section className="sheet mt-8 rounded-[28px] px-5 py-6 md:px-8 md:py-8">
      <p className="text-xs tracking-[0.16em] text-muted-foreground">听歌</p>
      <h2 className="mt-2 font-figure text-3xl tracking-tight">降到 432 Hz</h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        {desktop
          ? "点开始。QQ 音乐、Edge 和 Chrome 改由音叉播出，并降到 432 Hz。选外放就从喇叭出声，选耳机就从耳机出声。"
          : "先听大约 8 秒，再按测得的基准音降到 432 Hz。用麦克风时请戴耳机，避免啸叫。"}
      </p>

      {desktop ? (
        <div className="mt-5 grid grid-cols-2 gap-1 rounded-full bg-muted p-1 sm:max-w-md">
          <Button
            type="button"
            variant="ghost"
            aria-pressed={output === "speakers"}
            disabled={running || busy}
            className={cn(
              "h-10 rounded-full",
              output === "speakers" && "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
            onClick={() => setOutput("speakers")}
          >
            外放
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-pressed={output === "headphones"}
            disabled={running || busy}
            className={cn(
              "h-10 rounded-full",
              output === "headphones" && "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
            onClick={() => setOutput("headphones")}
          >
            耳机
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-1 rounded-full bg-muted p-1 sm:max-w-md">
            <Button
              type="button"
              variant="ghost"
              aria-pressed={source === "mic"}
              disabled={running || busy}
              className={cn(
                "h-10 rounded-full",
                source === "mic" && "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
              onClick={() => setSource("mic")}
            >
              麦克风
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-pressed={source === "display"}
              disabled={running || busy}
              className={cn(
                "h-10 rounded-full",
                source === "display" && "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
              onClick={() => setSource("display")}
            >
              分享声音
            </Button>
          </div>
          {source === "mic" && (
            <label className="mt-5 flex items-center justify-between gap-4 text-sm sm:max-w-md">
              <span>
                <span className="block">我戴着耳机</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">避免喇叭和麦克风啸叫。</span>
              </span>
              <Switch checked={headphones} onCheckedChange={setHeadphones} aria-label="我戴着耳机" />
            </label>
          )}
        </>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {!running && (
          <Button
            type="button"
            className="h-11 rounded-full px-5"
            disabled={busy || (!desktop && source === "mic" && !headphones)}
            onClick={() =>
              void (desktop ? startDesktop() : runOnce(async () => {
                await begin(sourceRef.current);
              }))
            }
          >
            {busy ? "请稍等" : phase === "error" ? "再试一次" : "开始"}
          </Button>
        )}
        {running && (
          <>
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-full px-5"
              disabled={busy}
              onClick={() => void (desktop ? stopDesktop() : stop())}
            >
              停止
            </Button>
            {phase === "shifting" && (
              <Button type="button" variant="outline" className="h-11 rounded-full px-5" disabled={busy} onClick={() => rejudge()}>
                再听一次
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

      <p className="mt-6 max-w-2xl text-sm leading-6 text-muted-foreground">
        {desktop
          ? "开始后先听 8 秒。切歌时，以及大约每 3 分钟，会再听一次并微调。点停止或退出音叉后，播放器不再被指定设备：插着耳机就走耳机，拔掉就回到外放。只关掉 QQ 音乐或 Edge 不会结束这一轮。"
          : "分享声音时，请勾选标签页音频或系统音频。macOS 经常拿不到系统声音，需要把播放改到 BlackHole 之类的虚拟声卡，再用麦克风听。"}
      </p>
    </section>
  );
}
