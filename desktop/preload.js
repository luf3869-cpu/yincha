/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, handler) {
  if (typeof handler !== "function") return () => {};
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("yinchaDesktop", {
  platform: process.platform,
  audioState: () => ipcRenderer.invoke("yincha:audio-state"),
  onAudioState: (handler) => subscribe("yincha:audio-state", handler),
  engage: () => ipcRenderer.invoke("yincha:engage"),
  release: () => ipcRenderer.invoke("yincha:release"),
  watchSongs: (enabled) => ipcRenderer.invoke("yincha:watch-songs", !!enabled),
  onSongChange: (handler) => subscribe("yincha:song-change", handler),
});
