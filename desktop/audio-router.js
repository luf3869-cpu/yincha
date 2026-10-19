/* eslint-disable @typescript-eslint/no-require-imports */
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const PLAYER_EXES = ["QQMusic.exe", "msedge.exe", "chrome.exe"];
// Older builds also pinned WebView2 and this app. Nobody else pins them, so any pin there is ours.
const LEGACY_EXES = ["msedgewebview2.exe", "音叉.exe"];
const RESTORE_EXES = [...PLAYER_EXES, ...LEGACY_EXES];
const APP_ROUTE_KEY = "HKCU\\Software\\Microsoft\\Multimedia\\Audio\\DefaultEndpoint";
const BOOT_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce";
const BOOT_VALUE = "YinchaRestoreAudio";
const SNAPSHOT_VERSION = 2;
const VIRTUAL_PLAYBACK = /todesk|dubbing|voicemeeter|vb-?audio|virtual\s*(cable|audio|device)|oculus|steam\s*streaming/i;

// The snapshot file is the whole state machine on disk:
//   absent             nothing of ours is in the system; idle never touches devices
//   engaging/engaged   players may point at CABLE Input; `original` is how to undo it
// It is written before the first change and deleted only after a restore is verified,
// so a crash at any point leaves either nothing or a snapshot the next start replays.

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
    .replace(/^﻿/, "")
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

function decodeText(buffer) {
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("gb18030").decode(buffer);
  } catch {
    return utf8;
  }
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

function isCableDevice(row) {
  return /vb-?audio/i.test(row?.["Device Name"] || "") || /^CABLE\b/.test(row?.Name || "");
}

function isHeadphone(row) {
  return /耳机|Headphone|Headset/i.test(row?.Name || "");
}

function isSpeaker(row) {
  return /扬声器|Speaker/i.test(row?.Name || "") && !/HDMI|Digital|数字/i.test(`${row?.Name || ""} ${row?.["Device Name"] || ""}`);
}

function isDefaultRender(row) {
  return row.Default === "Render" || row["Default Multimedia"] === "Render";
}

// Where the retuned sound goes. A plugged-in wired headphone wins: on jack-sensing codecs
// the headphone is its own endpoint while the speaker endpoint stays active. Otherwise
// follow the Windows default (Bluetooth, USB DAC), then any real speaker.
function pickListenDevice(rows) {
  const devices = activeDevices(rows).filter((row) => row.Direction === "Render" && !isVirtualPlayback(row));
  const unmuted = (list) => list.find((row) => row.Muted !== "Yes") || list[0] || null;
  return (
    unmuted(devices.filter(isHeadphone)) ||
    devices.find(isDefaultRender) ||
    unmuted(devices.filter(isSpeaker)) ||
    unmuted(devices)
  );
}

function describeDevice(row) {
  return { id: row["Item ID"] || "", name: row.Name || "", deviceName: row["Device Name"] || "" };
}

function sameId(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
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
  return pins.filter((pin) => RESTORE_EXES.some((exe) => sameId(exe, pin.exe)));
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function defaultRunFile(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, ...options }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function defaultRunReg(args) {
  const out = await defaultRunFile("reg", args, { encoding: "buffer" });
  return decodeText(Buffer.isBuffer(out) ? out : Buffer.from(out || ""));
}

function createAudioRouter({ svclPath, stateFile, runFile = defaultRunFile, runReg = defaultRunReg }) {
  // Every svcl / reg call goes through one queue, so a device poll never interleaves with
  // an engage or restore, and nothing blocks the Electron main thread.
  const migratedFile = path.join(path.dirname(stateFile), "audio-pins-v2");
  let chain = Promise.resolve();
  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  function serial(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

  function svclExists() {
    return Boolean(svclPath && fs.existsSync(svclPath));
  }

  async function svcl(args) {
    if (!svclExists()) return { ok: false, error: "找不到 svcl.exe" };
    try {
      await runFile(svclPath, args);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  async function reg(args) {
    try {
      return { ok: true, out: await runReg(args) };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  async function listRows() {
    if (!svclExists()) return [];
    const csvPath = path.join(path.dirname(stateFile), "devices-now.csv");
    try {
      fs.mkdirSync(path.dirname(csvPath), { recursive: true });
      await runFile(svclPath, ["/scomma", csvPath]);
      return parseDeviceCsv(decodeText(fs.readFileSync(csvPath)));
    } catch {
      return [];
    }
  }

  async function readPins() {
    // A missing key just means no app has ever been pinned. Unpinned apps keep an empty entry.
    const result = await reg(["query", APP_ROUTE_KEY, "/s"]);
    return result.ok ? parseAppRouteQuery(result.out).filter((pin) => pin.endpointId) : [];
  }

  function loadSnapshot() {
    try {
      if (!fs.existsSync(stateFile)) return null;
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      // Unreadable still means something was in progress; restore treats it like a legacy snapshot.
      return { phase: "unknown" };
    }
  }

  function saveSnapshot(snapshot) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(snapshot, null, 2), "utf8");
  }

  function forgetSnapshot() {
    try {
      fs.unlinkSync(stateFile);
    } catch {
      /* already gone */
    }
  }

  function findCable(rows) {
    const devices = activeDevices(rows);
    return {
      cableIn: devices.find((row) => row.Direction === "Render" && row.Name === "CABLE Input") || null,
      cableOut: devices.find((row) => row.Direction === "Capture" && row.Name === "CABLE Output") || null,
    };
  }

  function levelOf(row) {
    const volume = Number.parseFloat(String(row["Volume Percent"] || "").replace("%", ""));
    return { id: row["Item ID"], muted: row.Muted === "Yes", volume: Number.isFinite(volume) ? Math.round(volume) : null };
  }

  // Back to "follow the system default", the same as choosing 默认 in Windows sound settings.
  function unpin(exe) {
    return svcl(["/SetAppDefault", "DefaultRenderDevice", "all", exe]);
  }

  async function restoreNow() {
    const snapshot = loadSnapshot();
    const rows = await listRows();
    if (snapshot && !rows.length) return { ok: false, restored: false, error: "读不到声卡列表，没法确认还原。" };
    const pins = await readPins();
    const byId = (id) => rows.find((row) => sameId(row["Item ID"], id)) || null;
    const ours = (pin) => isCableDevice(byId(pin.endpointId)) || LEGACY_EXES.some((exe) => sameId(exe, pin.exe));
    const results = [];
    const handled = new Set();

    if (snapshot?.version === SNAPSHOT_VERSION && snapshot.original) {
      for (const want of snapshot.original.pins || []) {
        handled.add(want.exe.toLowerCase());
        const current = pins.find((pin) => sameId(pin.exe, want.exe));
        const target = want.endpointId ? byId(want.endpointId) : null;
        // Put back a pin the user made themselves, if that device is still around.
        if (target && target["Device State"] === "Active" && !isCableDevice(target)) {
          if (!sameId(current?.endpointId, want.endpointId)) {
            results.push(await svcl(["/SetAppDefault", want.endpointId, "all", want.exe]));
          }
        } else if (current) {
          results.push(await unpin(want.exe));
        }
      }
      for (const level of snapshot.original.cable || []) {
        if (!byId(level.id)) continue;
        if (level.volume !== null) results.push(await svcl(["/SetVolume", level.id, String(level.volume)]));
        results.push(await svcl([level.muted ? "/Mute" : "/Unmute", level.id]));
      }
    }

    // Whatever is still ours. Older builds "restored" by pinning players to a physical device
    // and kept no record of the original, so the first run of this build, or a snapshot left by
    // an older one, sends every managed pin back to the system default.
    const legacy = !fs.existsSync(migratedFile) || (Boolean(snapshot) && snapshot.version !== SNAPSHOT_VERSION);
    for (const pin of pins) {
      if (handled.has(pin.exe.toLowerCase())) continue;
      if (legacy || ours(pin)) results.push(await unpin(pin.exe));
    }

    // Verify instead of trusting exit codes: the snapshot goes only once nothing of ours is left.
    const failures = results.filter((result) => !result.ok).map((result) => result.error);
    if (results.length) {
      const stuck = (await readPins()).filter(ours);
      if (stuck.length) failures.push(`${stuck.map((pin) => pin.exe).join("、")} 还接在虚拟声卡上`);
    }
    if (failures.length) {
      return { ok: false, restored: false, error: failures.filter(Boolean).join("；") || "声卡没有还原" };
    }
    if (snapshot) {
      forgetSnapshot();
      await reg(["delete", BOOT_KEY, "/v", BOOT_VALUE, "/f"]);
    }
    if (!fs.existsSync(migratedFile)) {
      fs.mkdirSync(path.dirname(migratedFile), { recursive: true });
      fs.writeFileSync(migratedFile, new Date().toISOString(), "utf8");
    }
    return { ok: true, restored: Boolean(snapshot) || results.length > 0 };
  }

  async function engageNow(bootCommand) {
    if (loadSnapshot()) {
      const restored = await restoreNow();
      if (!restored.ok) return { ok: false, error: `上次的设置还没还原：${restored.error}` };
    }
    const rows = await listRows();
    const { cableIn, cableOut } = findCable(rows);
    if (!cableIn || !cableOut) return { ok: false, error: "未找到 VB-CABLE。请先安装虚拟声卡并重启电脑。" };
    const listen = pickListenDevice(rows);
    if (!listen) return { ok: false, error: "没有找到可用的耳机或外放。" };

    const pins = await readPins();
    const original = {
      pins: PLAYER_EXES.map((exe) => {
        const pin = pins.find((item) => sameId(item.exe, exe));
        return { exe, endpointId: pin && !isCableDevice(rows.find((row) => sameId(row["Item ID"], pin.endpointId))) ? pin.endpointId : "" };
      }),
      cable: [levelOf(cableIn), levelOf(cableOut)],
    };
    saveSnapshot({ version: SNAPSHOT_VERSION, phase: "engaging", original, savedAt: new Date().toISOString() });
    // If the machine dies mid-session, the next login runs one headless restore.
    if (bootCommand) await reg(["add", BOOT_KEY, "/v", BOOT_VALUE, "/t", "REG_SZ", "/d", bootCommand, "/f"]);

    const results = [
      await svcl(["/Unmute", cableOut["Item ID"]]),
      await svcl(["/Unmute", cableIn["Item ID"]]),
      await svcl(["/SetVolume", cableOut["Item ID"], "100"]),
      await svcl(["/SetVolume", cableIn["Item ID"], "100"]),
    ];
    for (const exe of PLAYER_EXES) {
      results.push(await svcl(["/SetAppDefault", cableIn["Item ID"], "all", exe]));
    }
    const failed = results.filter((result) => !result.ok);
    if (failed.length) {
      const rollback = await restoreNow();
      const error = failed.map((result) => result.error).join("；") || "没有接上虚拟声卡。";
      return { ok: false, error: rollback.ok ? error : `${error}；还原也失败了：${rollback.error}` };
    }
    saveSnapshot({ version: SNAPSHOT_VERSION, phase: "engaged", original, savedAt: new Date().toISOString() });
    return { ok: true, listen: describeDevice(listen) };
  }

  // While engaged: keep players on the cable and report where the retuned sound should go.
  async function reconcileNow() {
    if (loadSnapshot()?.phase !== "engaged") return { ok: false, error: "没有在接管。" };
    const rows = await listRows();
    const { cableIn } = findCable(rows);
    if (!cableIn) return { ok: false, error: "VB-CABLE 不见了。" };
    const pins = await readPins();
    for (const exe of PLAYER_EXES) {
      const pin = pins.find((item) => sameId(item.exe, exe));
      if (!pin || !sameId(pin.endpointId, cableIn["Item ID"])) {
        await svcl(["/SetAppDefault", cableIn["Item ID"], "all", exe]);
      }
    }
    const listen = pickListenDevice(rows);
    return { ok: true, listen: listen ? describeDevice(listen) : null };
  }

  function createSongWatcher(onChange) {
    let timer = null;
    let lastKey = "";
    let ticking = false;
    const tick = async () => {
      if (ticking) return;
      ticking = true;
      try {
        const song = await serial(async () => pickSong(await listRows()));
        if (!timer || !song) return;
        const key = `${song.process}::${song.title}`;
        if (key === lastKey) return;
        const previous = lastKey;
        lastKey = key;
        if (previous) onChange(song);
      } finally {
        ticking = false;
      }
    };
    return {
      start(intervalMs = 2000) {
        if (timer) return;
        timer = setInterval(() => void tick(), intervalMs);
        void tick();
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
    loadSnapshot,
    restore: () => serial(restoreNow),
    engage: (bootCommand) => serial(() => engageNow(bootCommand)),
    reconcile: () => serial(reconcileNow),
    createSongWatcher,
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
  LEGACY_EXES,
  RESTORE_EXES,
  parseDeviceCsv,
  normalizeTitle,
  looksLikeSong,
  pickSong,
  pickListenDevice,
  parseAppRouteQuery,
  createAudioRouter,
  resolveSvclPath,
};
