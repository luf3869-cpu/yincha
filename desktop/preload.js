/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("yinchaDesktop", {
  platform: process.platform,
  setupCable: (output) => ipcRenderer.invoke("yincha:setup-cable", output === "headphones" ? "headphones" : "speakers"),
  restoreAudio: () => ipcRenderer.invoke("yincha:restore-audio"),
  watchSongs: (enabled) => ipcRenderer.invoke("yincha:watch-songs", !!enabled),
  onSongChange: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, song) => handler(song);
    ipcRenderer.on("yincha:song-change", listener);
    return () => ipcRenderer.removeListener("yincha:song-change", listener);
  },
});
