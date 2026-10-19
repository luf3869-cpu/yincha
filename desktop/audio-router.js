/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PLAYER_EXES = ["QQMusic.exe", "msedge.exe", "chrome.exe"];
// Older builds also pinned WebView2 and this app. Idle clears those pins.
const RESTORE_EXES = [...PLAYER_EXES, "msedgewebview2.exe", "音叉.exe"];
const APP_ROUTE_KEY = "HKCU\\Software\\Microsoft\\Multimedia\\Audio\\DefaultEndpoint";
const VIRTUAL_PLAYBACK = /todesk|dubbing|voicemeeter|vb-?audio|virtual\s*(cable|audio|device)|oculus|steam\s*streaming/i;

// idle: system playback follows the jack, capture stays a real mic, players are not pinned.
// engaged: QQ / Edge / Chrome render only into CABLE Input. This app listens to CABLE Output.

function splitCsv(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += char;
  }
  out.push(cur);
  return out;
}

function parseDeviceCsv(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = splitCsv(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitCsv(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cols[index] ?? "";
    });
    return row;
  });
}

function processNameFromPath(processPath) {
  const base = path.win32.basename(String(processPath || ""));
  return base.replace(/\.exe$/i, "");
}

function normalizeTitle(title, processName) {
  let text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (processName === "QQMusic") text = text.replace(/\s*-\s*QQ音乐\s*$/i, "").trim();
  text = text
    .replace(/\s*-\s*Microsoft\s*Edge\s*$/i, "")
    .replace(/\s*-\s*Google\s*Chrome\s*$/i, "")
    .replace(/\s*和其他\s*\d+\s*个页面$/i, "")
    .replace(/\s*and\s+\d+\s+more\s+pages$/i, "")
    .trim();
  return text;
}

function looksLikeSong(processName, title) {
  const text = normalizeTitle(title, processName);
  if (text.length < 2) return false;
  if (processName === "QQMusic") return !/^QQ音乐$/i.test(text);
  if (/^(新标签页|new tab|设置|settings|downloads|下载|扩展程序|extensions|历史记录|history)$/i.test(text)) {
    return false;
  }
  if (/outlook|teams|slack|word|excel|powerpoint|微信|钉钉|邮件|收件箱|inbox|github|stackoverflow/i.test(text)) {
    return false;
  }
  return (
    /网易云|qq音乐|spotify|youtube|bilibili|音乐|song|playlist/i.test(text) ||
    /.+\s[-–—|]\s.+/.test(text)
  );
}

function pickSong(rows) {
  const apps = rows
    .filter((row) => row.Type === "Application")
    .map((row) => {
      const processName = processNameFromPath(row["Process Path"]);
      return {
        process: processName,
        title: normalizeTitle(row["Window Title"], processName),
        pid: Number(row["Process ID"]) || 0,
      };
    })
    .filter((row) => looksLikeSong(row.process, row.title));

  return (
    apps.find((row) => row.process === "QQMusic") ||
    apps.find((row) => row.process === "msedge" || row.process === "chrome") ||
    null
  );
}

function activeDevices(rows) {
  return rows.filter((row) => row.Type === "Device" && row["Device State"] === "Active");
}

function isVirtualPlayback(row) {
  return VIRTUAL_PLAYBACK.test(`${row?.Name || ""} ${row?.["Device Name"] || ""}`);
}

function isHeadphone(row) {
  return /耳机|Headphone|Headset/i.test(row?.Name || "");
}

function isSpeaker(row) {
  return /扬声器|Speaker/i.test(row?.Name || "") && !/HDMI|Digital|数字/i.test(`${row?.Name || ""} ${row?.["Device Name"] || ""}`);
}

function followsJack(row) {
  return !row || isVirtualPlayback(row) || isHeadphone(row) || isSpeaker(row);
}

function pickListenDevice(rows, prefer = "headphones") {
  const devices = activeDevices(rows).filter((row) => row.Direction === "Render" && !isVirtualPlayback(row));
  const phones = devices.filter((row) => isHeadphone(row));
  const speakers = devices.filter((row) => isSpeaker(row));
  const unmuted = (list) => list.find((row) => row.Muted !== "Yes");
  if (prefer === "speakers") return unmuted(speakers) || speakers[0] || unmuted(phones) || phones[0] || null;
  return unmuted(phones) || phones[0] || unmuted(speakers) || speakers[0] || null;
}

function pickPhysicalCapture(rows) {
  const devices = activeDevices(rows).filter((row) => row.Direction === "Capture" && !isVirtualPlayback(row));
  return (
    devices.find((row) => /阵列麦克风/i.test(row.Name || "")) ||
    devices.find((row) => /麦克风|Microphone/i.test(row.Name || "")) ||
    devices[0] ||
    null
  );
}

function parseAppRouteQuery(text) {
  const pins = [];
  const blocks = String(text || "").split(/\r?\n(?=HKEY_)/);
  for (const block of blocks) {
    const key = block.match(/HKEY_CURRENT_USER\\Software\\Microsoft\\Multimedia\\Audio\\DefaultEndpoint\\[^\r\n]+/i);
    const value = block.match(/(?:\(Default\)|\(默认\))\s+REG_\w+\s+(.+)/i);
    if (!key || !value) continue;
    const exe = path.win32.basename(value[1].trim());
    const endpoint = block.match(/MMDEVAPI#(\{0\.0\.[01]\.00000000\}\.\{[0-9a-f-]+\})/i);
    pins.push({ key: key[0].trim(), exe, endpointId: endpoint ? endpoint[1] : "" });
  }
  return pins.filter((pin) => RESTORE_EXES.some((exe) => exe.toLowerCase() === pin.exe.toLowerCase()));
}

function defaultRunReg(args) {
  const result = execFileSync("reg", args, { encoding: "buffer", windowsHide: true, timeout: 15000 });
  const buffer = Buffer.isBuffer(result) ? result : Buffer.from(result || "");
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gb18030").decode(buffer);
  } catch {
    return utf8;
  }
}

function createAudioRouter({ svclPath, stateFile, runFile, runReg = defaultRunReg }) {
  const runFileSync = runFile || execFileSync;
  const reg = runReg;
  let settledPlaybackId = "";

  function svclExists() {
    return Boolean(svclPath && fs.existsSync(svclPath));
  }

  function runSvcl(args) {
    if (!svclExists()) return { ok: false, error: "找不到 svcl.exe" };
    try {
      const out = runFileSync(svclPath, args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      });
      return { ok: true, out: out || "" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function listRows() {
    if (!svclExists()) return [];
    const csvPath = path.join(path.dirname(stateFile), "devices-now.csv");
    try {
      fs.mkdirSync(path.dirname(csvPath), { recursive: true });
      runFileSync(svclPath, ["/scomma", csvPath], { windowsHide: true, timeout: 15000 });
      const buffer = fs.readFileSync(csvPath);
      const utf8 = buffer.toString("utf8");
      let decoded = utf8;
      if (utf8.includes("\uFFFD")) {
        try {
          decoded = new TextDecoder("gb18030").decode(buffer);
        } catch {
          decoded = utf8;
        }
      }
      return parseDeviceCsv(decoded);
    } catch {
      return [];
    }
  }

  function currentDefaults() {
    const devices = activeDevices(listRows());
    const playback = devices.find(
      (row) => row.Direction === "Render" && (row.Default === "Render" || row["Default Multimedia"] === "Render"),
    );
    const recording = devices.find(
      (row) => row.Direction === "Capture" && (row.Default === "Capture" || row["Default Multimedia"] === "Capture"),
    );
    return {
      playbackId: playback?.["Item ID"] || "",
      playbackName: playback?.Name || "",
      recordingId: recording?.["Item ID"] || "",
      recordingName: recording?.Name || "",
    };
  }

  function loadSnapshot() {
    try {
      if (!fs.existsSync(stateFile)) return null;
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return null;
    }
  }

  function saveSnapshot(snapshot) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(snapshot, null, 2), "utf8");
  }

  function queryPins() {
    try {
      return parseAppRouteQuery(reg(["query", APP_ROUTE_KEY, "/s"]));
    } catch {
      return [];
    }
  }

  function sameId(left, right) {
    return String(left || "").toLowerCase() === String(right || "").toLowerCase();
  }

  function forgetSnapshot() {
    try {
      fs.unlinkSync(stateFile);
    } catch {
      /* already gone */
    }
  }

  function deviceById(rows, itemId) {
    return rows.find((row) => sameId(row["Item ID"], itemId)) || null;
  }

  function healSystem(rows, results) {
    const defaults = currentDefaults();
    const playback = deviceById(rows, defaults.playbackId);
    const desiredPlay = pickListenDevice(rows, "headphones");
    const recording = deviceById(rows, defaults.recordingId);
    const desiredMic = !recording || isVirtualPlayback(recording) ? pickPhysicalCapture(rows) : null;
    if (desiredPlay && followsJack(playback) && !sameId(defaults.playbackId, desiredPlay["Item ID"])) {
      results.push(runSvcl(["/SetDefault", desiredPlay["Item ID"], "all"]));
    }
    if (desiredMic && !sameId(defaults.recordingId, desiredMic["Item ID"])) {
      results.push(runSvcl(["/SetDefault", desiredMic["Item ID"], "all"]));
    }
    return { desiredPlay, desiredMic: desiredMic || recording };
  }

  function finish(results, names) {
    const ok = results.every((result) => result.ok !== false);
    return {
      ok,
      restored: ok && results.length > 0,
      playbackName: names.playbackName || "",
      recordingName: names.recordingName || "",
      error: ok ? undefined : results.map((result) => result.error).filter(Boolean).join("；") || "声卡没有还原",
    };
  }

  function applyCableRouting(prefer = "speakers") {
    const output = prefer === "headphones" ? "headphones" : "speakers";
    const rows = listRows();
    const devices = activeDevices(rows);
    const cableIn = devices.find((row) => row.Direction === "Render" && row.Name === "CABLE Input");
    const cableOut = devices.find((row) => row.Direction === "Capture" && row.Name === "CABLE Output");
    const listen = pickListenDevice(rows, output);
    if (!cableIn || !cableOut) {
      return { ok: false, error: "未找到 VB-CABLE。请先安装虚拟声卡并重启电脑。", listenDevice: "" };
    }
    if (!listen || (output === "headphones" && !isHeadphone(listen))) {
      return {
        ok: false,
        error: output === "headphones" ? "没有检测到耳机。" : "没有找到可用的外放或耳机。",
        listenDevice: "",
      };
    }

    const results = [];
    healSystem(rows, results);
    results.push(
      runSvcl(["/Unmute", cableOut["Item ID"]]),
      runSvcl(["/Unmute", cableIn["Item ID"]]),
      runSvcl(["/Unmute", listen["Item ID"]]),
      runSvcl(["/SetVolume", cableOut["Item ID"], "100"]),
      runSvcl(["/SetVolume", cableIn["Item ID"], "100"]),
    );
    for (const exe of PLAYER_EXES) {
      results.push(runSvcl(["/SetAppDefault", cableIn["Item ID"], "all", exe]));
    }
    const ok = results.every((result) => result.ok !== false);
    if (!ok) {
      return {
        ok: false,
        error: results.map((result) => result.error).filter(Boolean).join("；") || "没有接上虚拟声卡。",
        listenDevice: listen.Name || "",
      };
    }
    saveSnapshot({ phase: "engaged", output, savedAt: new Date().toISOString() });
    return {
      ok: true,
      cableIn: cableIn.Name,
      cableOut: cableOut.Name,
      listenDevice: listen.Name || "",
    };
  }

  function restoreAudio() {
    const snapshot = loadSnapshot();
    const rows = listRows();
    const pins = queryPins();
    const defaults = rows.length ? currentDefaults() : { playbackId: "", recordingId: "" };
    const desiredPlay = rows.length ? pickListenDevice(rows, "headphones") : null;
    const desiredId = desiredPlay?.["Item ID"] || "";
    const playback = deviceById(rows, defaults.playbackId);
    const recording = deviceById(rows, defaults.recordingId);
    const captureDrift = !recording || isVirtualPlayback(recording);
    const playbackDrift = Boolean(desiredId) && followsJack(playback) && !sameId(defaults.playbackId, desiredId);
    const sessionDrift = Boolean(settledPlaybackId) && Boolean(desiredId) && !sameId(settledPlaybackId, desiredId);
    if (!snapshot && !pins.length && !playbackDrift && !captureDrift && !sessionDrift) {
      settledPlaybackId = defaults.playbackId || settledPlaybackId;
      return { ok: true, restored: false, playbackName: playback?.Name || "", recordingName: recording?.Name || "" };
    }

    const results = [];
    const healed = rows.length ? healSystem(rows, results) : { desiredPlay: null, desiredMic: null };
    const releaseTarget = followsJack(playback) ? desiredPlay : playback;
    const targetId = releaseTarget?.["Item ID"] || "";
    if (targetId && (pins.length || playbackDrift || sessionDrift || snapshot)) {
      for (const exe of RESTORE_EXES) results.push(runSvcl(["/SetAppDefault", targetId, "all", exe]));
    }
    if (pins.length) {
      for (const pin of pins) {
        try {
          reg(["delete", pin.key, "/f"]);
          results.push({ ok: true });
        } catch (error) {
          results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    const names = {
      playbackName: releaseTarget?.Name || healed.desiredPlay?.Name || playback?.Name || "",
      recordingName: healed.desiredMic?.Name || recording?.Name || "",
    };
    const outcome = finish(results, names);
    if (outcome.ok) {
      settledPlaybackId = targetId || defaults.playbackId || "";
      forgetSnapshot();
      settledPlaybackId = targetId || defaults.playbackId || "";
    }
    if (!results.length) return { ...outcome, restored: Boolean(snapshot) && outcome.ok };
    return outcome;
  }

  function reconcileEngaged() {
    if (loadSnapshot()?.phase !== "engaged") return restoreAudio();
    const rows = listRows();
    const devices = activeDevices(rows);
    const cableIn = devices.find((row) => row.Direction === "Render" && row.Name === "CABLE Input");
    if (!cableIn) return { ok: false, error: "未找到 VB-CABLE。" };
    const results = [];
    healSystem(rows, results);
    const pins = queryPins();
    for (const exe of PLAYER_EXES) {
      const pin = pins.find((item) => item.exe.toLowerCase() === exe.toLowerCase());
      if (!pin || !sameId(pin.endpointId, cableIn["Item ID"])) {
        results.push(runSvcl(["/SetAppDefault", cableIn["Item ID"], "all", exe]));
      }
    }
    for (const pin of pins) {
      if (PLAYER_EXES.some((exe) => exe.toLowerCase() === pin.exe.toLowerCase())) continue;
      try {
        reg(["delete", pin.key, "/f"]);
        results.push({ ok: true });
      } catch (error) {
        results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return finish(results, { playbackName: "", recordingName: "" });
  }

  function readNowPlaying() {
    return pickSong(listRows());
  }

  function createSongWatcher(onChange) {
    let timer = null;
    let lastKey = "";
    const tick = () => {
      const song = readNowPlaying();
      if (!song) return;
      const key = `${song.process}::${song.title}`;
      if (key === lastKey) return;
      const previous = lastKey;
      lastKey = key;
      if (previous) onChange(song);
    };
    return {
      start(intervalMs = 2000) {
        if (timer) return;
        tick();
        timer = setInterval(tick, intervalMs);
      },
      stop() {
        if (timer) clearInterval(timer);
        timer = null;
        lastKey = "";
      },
    };
  }

  return {
    svclExists,
    applyCableRouting,
    restoreAudio,
    loadSnapshot,
    createSongWatcher,
    readNowPlaying,
    reconcileEngaged,
  };
}

function resolveSvclPath(execPath = process.execPath) {
  const candidates = [
    path.join(path.dirname(execPath), "tools", "svcl", "svcl.exe"),
    path.resolve(__dirname, "../tools/svcl/svcl.exe"),
    path.resolve(__dirname, "../../tools/svcl/svcl.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[1];
}

module.exports = {
  PLAYER_EXES,
  RESTORE_EXES,
  parseDeviceCsv,
  normalizeTitle,
  looksLikeSong,
  pickSong,
  pickListenDevice,
  pickPhysicalCapture,
  parseAppRouteQuery,
  createAudioRouter,
  resolveSvclPath,
};
