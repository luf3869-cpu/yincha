/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { createAudioRouter, resolveSvclPath } = require("./audio-router");

const root = path.resolve(__dirname, "../out");

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json",
};

function uniqueDownloadPath(directory, filename) {
  const safe = filename.replace(/[\\/:*?"<>|]/g, " ").trim() || "歌曲-432Hz.wav";
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  let candidate = path.join(directory, safe);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (pathname.endsWith("/")) pathname += "index.html";
      const file = path.resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403);
        response.end();
        return;
      }
      fs.readFile(file, (error, data) => {
        if (error) {
          response.writeHead(404);
          response.end("not found");
          return;
        }
        const type = types[path.extname(file).toLowerCase()] || "application/octet-stream";
        response.writeHead(200, { "Content-Type": type });
        response.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("端口没有打开"));
        return;
      }
      resolve({ server, port: address.port });
    });
    server.on("error", reject);
  });
}

let windowRef = null;
let audioRouter = null;
let songWatcher = { start() {}, stop() {} };
let deviceTimer = null;

function initAudioRouter() {
  audioRouter = createAudioRouter({
    svclPath: resolveSvclPath(),
    stateFile: path.join(app.getPath("userData"), "audio-state.json"),
  });
  songWatcher = audioRouter.createSongWatcher((song) => {
    if (!windowRef || windowRef.isDestroyed()) return;
    windowRef.webContents.send("yincha:song-change", song);
  });
}

function restoreAudioSafely() {
  return runAudio(() => {
    songWatcher.stop();
    try {
      return audioRouter.restoreAudio();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function tickDevices() {
  if (!audioRouter || audioBusy) return;
  runAudio(() => {
    try {
      const snapshot = audioRouter.loadSnapshot();
      if (snapshot?.phase === "engaged") return audioRouter.reconcileEngaged();
      return audioRouter.restoreAudio();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function startDeviceWatch() {
  if (process.platform !== "win32" || deviceTimer) return;
  tickDevices();
  deviceTimer = setInterval(tickDevices, 4000);
}

function stopDeviceWatch() {
  if (!deviceTimer) return;
  clearInterval(deviceTimer);
  deviceTimer = null;
}

let audioBusy = false;

function runAudio(task) {
  if (audioBusy) return { ok: false, error: "上一步还在处理，请稍等。" };
  audioBusy = true;
  try {
    return task();
  } finally {
    audioBusy = false;
  }
}

function registerIpc() {
  ipcMain.handle("yincha:setup-cable", (_event, prefer) => {
    if (process.platform !== "win32") return { ok: false, error: "仅 Windows 支持虚拟声卡路由" };
    return runAudio(() => audioRouter.applyCableRouting(prefer === "headphones" ? "headphones" : "speakers"));
  });
  ipcMain.handle("yincha:restore-audio", () => restoreAudioSafely());
  ipcMain.handle("yincha:watch-songs", (_event, enabled) => {
    if (enabled) songWatcher.start(2000);
    else songWatcher.stop();
    return { ok: true };
  });
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 390,
    minHeight: 640,
    title: "音叉",
    autoHideMenuBar: true,
    backgroundColor: "#f3ead8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") event.preventDefault();
  });
  if (process.env.YINCHA_SMOKE === "1") {
    win.webContents.on("did-finish-load", () => {
      console.log("YINCHA_SMOKE_OK");
      app.quit();
    });
  }
  void win.loadURL(`http://127.0.0.1:${port}/`);
  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!windowRef) return;
    if (windowRef.isMinimized()) windowRef.restore();
    windowRef.focus();
  });

  app.whenReady().then(async () => {
    if (!fs.existsSync(path.join(root, "index.html"))) {
      dialog.showErrorBox("音叉", "程序文件不完整。请重新解压整个文件夹，不要只拷贝 exe。");
      app.quit();
      return;
    }

    initAudioRouter();
    registerIpc();

    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(["media", "display-capture", "audioCapture", "videoCapture", "fullscreen"].includes(permission));
    });

    session.defaultSession.on("will-download", (_event, item) => {
      item.setSavePath(uniqueDownloadPath(app.getPath("downloads"), item.getFilename()));
    });

    if (process.platform === "win32") {
      session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ["screen"] }).then(
          (sources) => {
            const source = sources[0];
            if (!source) {
              callback(null);
              return;
            }
            // loopbackWithMute mutes the whole playback endpoint, including this app.
            callback({ video: source, audio: "loopback" });
          },
          () => callback(null),
        );
      });
    }

    const { port } = await startServer();
    windowRef = createWindow(port);
    startDeviceWatch();
  }).catch((error) => {
    dialog.showErrorBox("音叉", error instanceof Error ? error.message : "没有打开");
    app.quit();
  });

  app.on("before-quit", () => {
    stopDeviceWatch();
    restoreAudioSafely();
  });

  app.on("window-all-closed", () => {
    stopDeviceWatch();
    restoreAudioSafely();
    app.quit();
  });
}
