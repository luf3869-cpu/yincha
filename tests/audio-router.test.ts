import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLAYER_EXES,
  RESTORE_EXES,
  createAudioRouter,
  looksLikeSong,
  normalizeTitle,
  parseDeviceCsv,
  parseAppRouteQuery,
  pickListenDevice,
  pickSong,
} from "../desktop/audio-router";

describe("song watching", () => {
  it("parses a device list and prefers the QQ Music title", () => {
    const rows = parseDeviceCsv(
      [
        "Name,Type,Process Path,Window Title,Process ID",
        "QQ音乐,Application,D:\\Music\\QQMusic.exe,晴天 - 周杰伦,10",
        "Edge,Application,C:\\Edge\\msedge.exe,新标签页,11",
        "Edge song,Application,C:\\Edge\\msedge.exe,夜曲 - 周杰伦 - 网易云音乐,12",
      ].join("\n"),
    );
    expect(pickSong(rows)).toMatchObject({ process: "QQMusic", title: "晴天 - 周杰伦" });
  });

  it("falls back to an Edge page that looks like a song", () => {
    const rows = parseDeviceCsv(
      ["Name,Type,Process Path,Window Title", "tab,Application,C:\\msedge.exe,夜曲 - 周杰伦 - Spotify"].join("\n"),
    );
    expect(pickSong(rows)?.process).toBe("msedge");
    expect(looksLikeSong("msedge", "新标签页")).toBe(false);
    expect(looksLikeSong("msedge", "收件箱 - Outlook")).toBe(false);
    expect(normalizeTitle("晴天 - QQ音乐", "QQMusic")).toBe("晴天");
  });

  it("routes QQ Music, Edge, and Chrome, and still restores WebView2", () => {
    expect(PLAYER_EXES).toEqual(["QQMusic.exe", "msedge.exe", "chrome.exe"]);
    expect(RESTORE_EXES).toContain("msedgewebview2.exe");
  });
});

describe("listen device", () => {
  const header = "Name,Type,Direction,Device Name,Device State,Muted,Item ID,Default,Default Multimedia";

  it("prefers a real headphone over a virtual speaker with the same endpoint name", () => {
    const rows = parseDeviceCsv(
      [
        header,
        "扬声器,Device,Render,ToDesk Virtual Audio,Active,No,todesk,,",
        "扬声器,Device,Render,Senary Audio,Active,Yes,speakers,Render,Render",
        "耳机,Device,Render,Senary Audio,Active,No,phones,,",
        "CABLE Input,Device,Render,VB-Audio Virtual Cable,Active,No,cable-in,,",
      ].join("\n"),
    );
    expect(pickListenDevice(rows)?.["Item ID"]).toBe("phones");
  });

  it("uses the real speaker when playback should stay on the speakers", () => {
    const rows = parseDeviceCsv(
      [
        header,
        "扬声器,Device,Render,ToDesk Virtual Audio,Active,No,todesk,,",
        "扬声器,Device,Render,Senary Audio,Active,No,speakers,,",
        "耳机,Device,Render,Senary Audio,Active,No,phones,,",
      ].join("\n"),
    );
    expect(pickListenDevice(rows, "speakers")?.["Item ID"]).toBe("speakers");
  });

  it("does not treat ToDesk as a speaker when no real output is active", () => {
    const rows = parseDeviceCsv(
      [header, "扬声器,Device,Render,ToDesk Virtual Audio,Active,No,todesk,,"].join("\n"),
    );
    expect(pickListenDevice(rows)).toBeNull();
  });
});

describe("app route registry", () => {
  it("reads managed players and ignores everyone else", () => {
    const text = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Multimedia\\Audio\\DefaultEndpoint\\qq",
      "    (Default)    REG_SZ    D:\\QQMusic\\QQMusic.exe",
      "    000_000    REG_SZ    \\\\?\\SWD#MMDEVAPI#{0.0.0.00000000}.{93f4d7b1-3025-4a30-9965-39930f75cfd1}#{e6327cad-dcec-4949-ae8a-991e976a79d2}",
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Multimedia\\Audio\\DefaultEndpoint\\edge",
      "    (默认)    REG_SZ    C:\\Edge\\msedge.exe",
      "    000_000    REG_SZ    \\\\?\\SWD#MMDEVAPI#{0.0.0.00000000}.{47e6397f-2a9e-4533-a685-8475ae00db41}#{e6327cad-dcec-4949-ae8a-991e976a79d2}",
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Multimedia\\Audio\\DefaultEndpoint\\note",
      "    (Default)    REG_SZ    C:\\Windows\\notepad.exe",
    ].join("\n");
    const pins = parseAppRouteQuery(text);
    expect(pins.map((pin) => pin.exe)).toEqual(["QQMusic.exe", "msedge.exe"]);
    expect(pins[1].endpointId).toBe("{0.0.0.00000000}.{47e6397f-2a9e-4533-a685-8475ae00db41}");
  });
});

describe("restore snapshot", () => {
  const header = "Name,Type,Direction,Device Name,Device State,Muted,Item ID,Default,Default Multimedia";
  const phoneId = "{0.0.0.00000000}.{f075f8b2-61f8-49e9-95a6-03e8836d4b61}";
  const speakerId = "{0.0.0.00000000}.{93f4d7b1-3025-4a30-9965-39930f75cfd1}";
  const micId = "{0.0.1.00000000}.{bea2d59d-b578-4229-8c2c-783c2ff4dddf}";
  const cableOutId = "{0.0.1.00000000}.{85252a79-e4ed-41e7-8d50-022954ae3ad8}";

  function deviceRouter(options: { csv: string; regText?: string; snapshot?: unknown; failOn?: string }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yincha-"));
    const stateFile = path.join(dir, "audio-state.json");
    const svclPath = path.join(dir, "svcl.exe");
    fs.writeFileSync(svclPath, "");
    if (options.snapshot) fs.writeFileSync(stateFile, JSON.stringify(options.snapshot));
    const commands: string[][] = [];
    const router = createAudioRouter({
      svclPath,
      stateFile,
      runFile: (_file: string, args: string[]) => {
        if (args[0] === "/scomma") {
          fs.writeFileSync(args[1], options.csv);
          return "";
        }
        if (options.failOn && args[0] === options.failOn) throw new Error("svcl failed");
        commands.push(args);
        return "";
      },
      runReg: (args: string[]) => {
        commands.push(["reg", ...args]);
        if (args[0] === "query") return options.regText || "";
        return "";
      },
    });
    return { router, stateFile, commands };
  }

  const healthy = [
    header,
    `耳机,Device,Render,Senary Audio,Active,No,${phoneId},Render,Render`,
    `扬声器,Device,Render,Senary Audio,Active,No,${speakerId},,`,
    `阵列麦克风,Device,Capture,AMD Audio,Active,No,${micId},Capture,Capture`,
  ].join("\n");

  const stuck = [
    header,
    `扬声器,Device,Render,Senary Audio,Active,No,${speakerId},Render,Render`,
    `耳机,Device,Render,Senary Audio,Active,No,${phoneId},,`,
    `CABLE Output,Device,Capture,VB-Audio Virtual Cable,Active,No,${cableOutId},Capture,Capture`,
    `阵列麦克风,Device,Capture,AMD Audio,Active,No,${micId},,`,
  ].join("\n");

  const stuckPins = [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Multimedia\\Audio\\DefaultEndpoint\\qq",
    `    (Default)    REG_SZ    D:\\QQMusic\\QQMusic.exe`,
    `    000_000    REG_SZ    \\\\?\\SWD#MMDEVAPI#${speakerId}#{e6327cad-dcec-4949-ae8a-991e976a79d2}`,
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Multimedia\\Audio\\DefaultEndpoint\\edge",
    "    (默认)    REG_SZ    C:\\Edge\\msedge.exe",
    "    000_000    REG_SZ    \\\\?\\SWD#MMDEVAPI#{0.0.0.00000000}.{47e6397f-2a9e-4533-a685-8475ae00db41}#{e6327cad-dcec-4949-ae8a-991e976a79d2}",
  ].join("\n");

  it("does nothing when playback already follows the jack and no app is pinned", () => {
    const { router, commands } = deviceRouter({ csv: healthy });
    expect(router.restoreAudio()).toMatchObject({ ok: true, restored: false });
    expect(commands.some((args) => args[0] === "/SetDefault" || args[0] === "/SetAppDefault")).toBe(false);
  });

  it("keeps the session record when a restore command fails", () => {
    const { router, stateFile } = deviceRouter({
      csv: stuck,
      snapshot: { phase: "engaged", output: "speakers" },
      failOn: "/SetDefault",
    });
    const result = router.restoreAudio();
    expect(result.ok).toBe(false);
    expect(result.restored).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it("moves a stuck speaker default onto live headphones and clears player pins", () => {
    const { router, stateFile, commands } = deviceRouter({
      csv: stuck,
      regText: stuckPins,
      snapshot: { phase: "engaged", output: "speakers", playbackId: speakerId, changedSystemDefault: false },
    });
    const result = router.restoreAudio();
    expect(result.ok).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.playbackName).toBe("耳机");
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(commands).toContainEqual(["/SetDefault", phoneId, "all"]);
    expect(commands).toContainEqual(["/SetDefault", micId, "all"]);
    expect(commands).toContainEqual(["/SetAppDefault", phoneId, "all", "QQMusic.exe"]);
    expect(commands).toContainEqual(["/SetAppDefault", phoneId, "all", "msedge.exe"]);
    expect(commands).toContainEqual(["/SetAppDefault", phoneId, "all", "音叉.exe"]);
    expect(commands).toContainEqual([
      "reg",
      "delete",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Multimedia\\Audio\\DefaultEndpoint\\edge",
      "/f",
    ]);
    expect(commands.some((args) => args[0] === "/SetDefault" && args[1] === speakerId)).toBe(false);
  });
});

describe("speaker routing", () => {
  it("routes players into the cable and the app onto the speakers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yincha-"));
    const stateFile = path.join(dir, "audio-state.json");
    const svclPath = path.join(dir, "svcl.exe");
    fs.writeFileSync(svclPath, "");
    const csv = [
      "Name,Type,Direction,Device Name,Device State,Muted,Item ID,Default,Default Multimedia",
      "CABLE Input,Device,Render,VB-Audio Virtual Cable,Active,No,cable-in,,",
      "CABLE Output,Device,Capture,VB-Audio Virtual Cable,Active,No,cable-out,,",
      "扬声器,Device,Render,Senary Audio,Active,No,speakers,Render,Render",
      "耳机,Device,Render,Senary Audio,Active,No,phones,,",
    ].join("\n");
    const commands: string[][] = [];
    const router = createAudioRouter({
      svclPath,
      stateFile,
      runFile: (_file: string, args: string[]) => {
        if (args[0] === "/scomma") fs.writeFileSync(args[1], csv);
        else commands.push(args);
        return "";
      },
    });
    const result = router.applyCableRouting("speakers");
    expect(result.ok).toBe(true);
    expect(result.listenDevice).toBe("扬声器");
    expect(commands).toContainEqual(["/SetDefault", "phones", "all"]);
    expect(commands).toContainEqual(["/SetAppDefault", "cable-in", "all", "QQMusic.exe"]);
    expect(commands.some((args) => args[0] === "/SetAppDefault" && args[3] === "音叉.exe")).toBe(false);
    const snapshot = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { phase: string; output: string };
    expect(snapshot).toMatchObject({ phase: "engaged", output: "speakers" });
  });

  it("moves the system default off the virtual cable before playing to speakers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yincha-"));
    const stateFile = path.join(dir, "audio-state.json");
    const svclPath = path.join(dir, "svcl.exe");
    fs.writeFileSync(svclPath, "");
    const csv = [
      "Name,Type,Direction,Device Name,Device State,Muted,Item ID,Default,Default Multimedia",
      "CABLE Input,Device,Render,VB-Audio Virtual Cable,Active,No,cable-in,Render,Render",
      "CABLE Output,Device,Capture,VB-Audio Virtual Cable,Active,No,cable-out,Capture,Capture",
      "扬声器,Device,Render,Senary Audio,Active,No,speakers,,",
      "耳机,Device,Render,Senary Audio,Active,No,phones,,",
    ].join("\n");
    const commands: string[][] = [];
    const router = createAudioRouter({
      svclPath,
      stateFile,
      runFile: (_file: string, args: string[]) => {
        if (args[0] === "/scomma") fs.writeFileSync(args[1], csv);
        else commands.push(args);
        return "";
      },
    });
    const result = router.applyCableRouting("speakers");
    expect(result.ok).toBe(true);
    expect(result.listenDevice).toBe("扬声器");
    expect(commands).toContainEqual(["/SetDefault", "phones", "all"]);
    expect(commands.some((args) => args[0] === "/SetAppDefault" && args[3] === "音叉.exe")).toBe(false);
  });
});
