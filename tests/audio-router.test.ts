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

  it("routes QQ Music, Edge, and Chrome, and still cleans up WebView2", () => {
    expect(PLAYER_EXES).toEqual(["QQMusic.exe", "msedge.exe", "chrome.exe"]);
    expect(RESTORE_EXES).toContain("msedgewebview2.exe");
  });
});

describe("listen device", () => {
  const header = "Name,Type,Direction,Device Name,Device State,Muted,Item ID,Default,Default Multimedia";

  it("prefers a plugged-in headphone over a virtual speaker with the same endpoint name", () => {
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

  it("falls back to the speaker once the headphone is unplugged", () => {
    const rows = parseDeviceCsv(
      [
        header,
        "扬声器,Device,Render,ToDesk Virtual Audio,Active,No,todesk,,",
        "扬声器,Device,Render,Senary Audio,Active,No,speakers,,",
        "耳机,Device,Render,Senary Audio,Unplugged,No,phones,,",
      ].join("\n"),
    );
    expect(pickListenDevice(rows)?.["Item ID"]).toBe("speakers");
  });

  it("follows a Bluetooth default that is neither 耳机 nor 扬声器 by name", () => {
    const rows = parseDeviceCsv(
      [
        header,
        "扬声器,Device,Render,Senary Audio,Active,No,speakers,,",
        "AirPods,Device,Render,Bluetooth,Active,No,bt,Render,Render",
      ].join("\n"),
    );
    expect(pickListenDevice(rows)?.["Item ID"]).toBe("bt");
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

describe("audio state machine", () => {
  const phones = "{0.0.0.00000000}.{f075f8b2-61f8-49e9-95a6-03e8836d4b61}";
  const speakers = "{0.0.0.00000000}.{93f4d7b1-3025-4a30-9965-39930f75cfd1}";
  const cableIn = "{0.0.0.00000000}.{47e6397f-2a9e-4533-a685-8475ae00db41}";
  const cableOut = "{0.0.1.00000000}.{85252a79-e4ed-41e7-8d50-022954ae3ad8}";
  const mic = "{0.0.1.00000000}.{bea2d59d-b578-4229-8c2c-783c2ff4dddf}";
  const header = "Name,Type,Direction,Device Name,Device State,Muted,Volume Percent,Item ID,Default,Default Multimedia";
  const devices = [
    header,
    `耳机,Device,Render,Senary Audio,Active,No,40%,${phones},Render,Render`,
    `扬声器,Device,Render,Senary Audio,Active,No,60%,${speakers},,`,
    `CABLE Input,Device,Render,VB-Audio Virtual Cable,Active,Yes,55%,${cableIn},,`,
    `CABLE Output,Device,Capture,VB-Audio Virtual Cable,Active,No,70%,${cableOut},,`,
    `阵列麦克风,Device,Capture,AMD Audio,Active,No,80%,${mic},Capture,Capture`,
  ].join("\n");

  // A tiny Windows: svcl and reg act on one shared table of per-app pins.
  function machine(options: {
    pins?: Record<string, string>;
    snapshot?: unknown;
    fresh?: boolean;
    csv?: string;
    failOn?: (args: string[]) => boolean;
    ignoreUnpin?: boolean;
  } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yincha-"));
    const stateFile = path.join(dir, "audio-state.json");
    const svclPath = path.join(dir, "svcl.exe");
    fs.writeFileSync(svclPath, "");
    if (!options.fresh) fs.writeFileSync(path.join(dir, "audio-pins-v2"), "");
    if (options.snapshot) fs.writeFileSync(stateFile, JSON.stringify(options.snapshot));
    const pins: Record<string, string> = { ...options.pins };
    const commands: string[][] = [];
    const runOnce: Record<string, string> = {};

    const router = createAudioRouter({
      svclPath,
      stateFile,
      runFile: async (_file: string, args: string[]) => {
        if (args[0] === "/scomma") {
          fs.writeFileSync(args[1], options.csv ?? devices);
          return "";
        }
        commands.push(args);
        if (options.failOn?.(args)) throw new Error("svcl failed");
        if (args[0] === "/SetAppDefault") {
          if (args[1] === "DefaultRenderDevice") {
            if (!options.ignoreUnpin) delete pins[args[3]];
          } else pins[args[3]] = args[1];
        }
        return "";
      },
      runReg: async (args: string[]) => {
        commands.push(["reg", ...args]);
        if (args[0] === "add") runOnce[args[3]] = args[7];
        if (args[0] === "delete" && args[2] === "/v") delete runOnce[args[3]];
        if (args[0] !== "query") return "";
        return Object.entries(pins)
          .map(([exe, id], index) =>
            [
              `HKEY_CURRENT_USER\\Software\\Microsoft\\Multimedia\\Audio\\DefaultEndpoint\\k${index}`,
              `    (Default)    REG_SZ    C:\\Apps\\${exe}`,
              `    000_000    REG_SZ    \\\\?\\SWD#MMDEVAPI#${id}#{e6327cad-dcec-4949-ae8a-991e976a79d2}`,
            ].join("\n"),
          )
          .join("\n\n");
      },
    });
    const snapshot = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null);
    return { router, pins, commands, runOnce, snapshot, dir };
  }

  it("leaves a clean system alone at startup, including the user's own pins", async () => {
    const m = machine({ pins: { "chrome.exe": speakers } });
    expect(await m.router.restore()).toMatchObject({ ok: true, restored: false });
    expect(m.pins).toEqual({ "chrome.exe": speakers });
    expect(m.commands.filter((args) => args[0] !== "reg")).toEqual([]);
  });

  it("first run of this build frees a player an older build pinned to the speakers", async () => {
    const m = machine({ fresh: true, pins: { "QQMusic.exe": speakers } });
    expect(await m.router.restore()).toMatchObject({ ok: true, restored: true });
    expect(m.pins).toEqual({});
    expect(fs.existsSync(path.join(m.dir, "audio-pins-v2"))).toBe(true);
    // Once migrated, a later start does not touch anything.
    m.pins["QQMusic.exe"] = speakers;
    expect(await m.router.restore()).toMatchObject({ ok: true, restored: false });
    expect(m.pins["QQMusic.exe"]).toBe(speakers);
  });

  it("records the original before changing anything, then routes players into the cable", async () => {
    const m = machine({ pins: { "chrome.exe": speakers } });
    const result = await m.router.engage("音叉.exe --restore-audio");
    expect(result).toMatchObject({ ok: true, listen: { id: phones, name: "耳机" } });
    expect(m.pins).toEqual({ "QQMusic.exe": cableIn, "msedge.exe": cableIn, "chrome.exe": cableIn });
    const saved = m.snapshot();
    expect(saved.phase).toBe("engaged");
    expect(saved.original.pins).toEqual([
      { exe: "QQMusic.exe", endpointId: "" },
      { exe: "msedge.exe", endpointId: "" },
      { exe: "chrome.exe", endpointId: speakers },
    ]);
    expect(saved.original.cable).toEqual([
      { id: cableIn, muted: true, volume: 55 },
      { id: cableOut, muted: false, volume: 70 },
    ]);
    expect(m.runOnce.YinchaRestoreAudio).toBe("音叉.exe --restore-audio");
    // The snapshot hit the disk before the first svcl change.
    const firstChange = m.commands.findIndex((args) => args[0] === "/Unmute");
    const bootEntry = m.commands.findIndex((args) => args[0] === "reg" && args[1] === "add");
    expect(bootEntry).toBeGreaterThan(-1);
    expect(bootEntry).toBeLessThan(firstChange);
  });

  it("puts everything back exactly as it was", async () => {
    const m = machine({ pins: { "chrome.exe": speakers } });
    await m.router.engage("boot");
    expect(await m.router.restore()).toMatchObject({ ok: true, restored: true });
    expect(m.pins).toEqual({ "chrome.exe": speakers });
    expect(m.commands).toContainEqual(["/SetVolume", cableIn, "55"]);
    expect(m.commands).toContainEqual(["/Mute", cableIn]);
    expect(m.commands).toContainEqual(["/SetAppDefault", "DefaultRenderDevice", "all", "QQMusic.exe"]);
    // Never pins a player to a physical device it was not on before.
    expect(m.commands.some((args) => args[0] === "/SetAppDefault" && args[1] === phones)).toBe(false);
    expect(m.snapshot()).toBeNull();
    expect(m.runOnce).toEqual({});
  });

  it("replays a snapshot left by a crash on the next start", async () => {
    const crashed = machine({ pins: { "chrome.exe": speakers } });
    await crashed.router.engage("boot");
    const leftover = crashed.snapshot();
    const m = machine({ snapshot: leftover, pins: { ...crashed.pins } });
    expect(await m.router.restore()).toMatchObject({ ok: true, restored: true });
    expect(m.pins).toEqual({ "chrome.exe": speakers });
    expect(m.snapshot()).toBeNull();
  });

  it("does not put back a user pin whose device is gone", async () => {
    const original = { pins: [{ exe: "chrome.exe", endpointId: "{0.0.0.00000000}.{00000000-0000-0000-0000-000000000000}" }], cable: [] };
    const m = machine({ snapshot: { version: 2, phase: "engaged", original }, pins: { "chrome.exe": cableIn } });
    expect(await m.router.restore()).toMatchObject({ ok: true });
    expect(m.pins).toEqual({});
  });

  it("treats a snapshot from an older build as 'free every managed player'", async () => {
    const m = machine({ snapshot: { phase: "engaged", output: "speakers" }, pins: { "QQMusic.exe": speakers, "msedge.exe": cableIn } });
    expect(await m.router.restore()).toMatchObject({ ok: true, restored: true });
    expect(m.pins).toEqual({});
  });

  it("keeps the snapshot when a restore command fails", async () => {
    const m = machine({ pins: {} });
    await m.router.engage("boot");
    const broken = machine({
      snapshot: m.snapshot(),
      pins: { ...m.pins },
      failOn: (args) => args[0] === "/SetAppDefault",
    });
    const result = await broken.router.restore();
    expect(result.ok).toBe(false);
    expect(broken.snapshot()).not.toBeNull();
  });

  it("does not trust svcl's exit code: a pin that stays on the cable is a failure", async () => {
    const m = machine({ pins: {} });
    await m.router.engage("boot");
    const liar = machine({ snapshot: m.snapshot(), pins: { ...m.pins }, ignoreUnpin: true });
    const result = await liar.router.restore();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("QQMusic.exe");
    expect(liar.snapshot()).not.toBeNull();
  });

  it("refuses to declare a snapshot restored when the device list cannot be read", async () => {
    const m = machine({ snapshot: { phase: "engaged" }, csv: "" });
    expect(await m.router.restore()).toMatchObject({ ok: false });
    expect(m.snapshot()).not.toBeNull();
  });

  it("rolls back when engaging fails halfway", async () => {
    const m = machine({ failOn: (args) => args[0] === "/SetAppDefault" && args[3] === "chrome.exe" && args[1] !== "DefaultRenderDevice" });
    const result = await m.router.engage("boot");
    expect(result.ok).toBe(false);
    expect(m.pins).toEqual({});
    expect(m.snapshot()).toBeNull();
    expect(m.runOnce).toEqual({});
  });

  it("does not engage without VB-CABLE, and changes nothing", async () => {
    const csv = devices.split("\n").filter((line) => !line.includes("CABLE")).join("\n");
    const m = machine({ csv });
    expect(await m.router.engage("boot")).toMatchObject({ ok: false });
    expect(m.snapshot()).toBeNull();
    expect(m.commands.filter((args) => args[0] !== "reg")).toEqual([]);
  });

  it("while engaged, puts a player back on the cable and reports the listen device", async () => {
    const m = machine();
    await m.router.engage("boot");
    m.pins["msedge.exe"] = speakers;
    expect(await m.router.reconcile()).toMatchObject({ ok: true, listen: { id: phones } });
    expect(m.pins["msedge.exe"]).toBe(cableIn);
  });

  it("reconcile does nothing when idle", async () => {
    const m = machine({ pins: { "chrome.exe": speakers } });
    expect(await m.router.reconcile()).toMatchObject({ ok: false });
    expect(m.pins).toEqual({ "chrome.exe": speakers });
  });
});
