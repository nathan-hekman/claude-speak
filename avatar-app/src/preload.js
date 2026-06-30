// Minimal, isolated bridge between the avatar renderer and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  // Pushed speech from claude-speak (via POST /speak -> main): { b64, text, format }.
  onSpeak: (cb) => ipcRenderer.on("speak", (_e, payload) => cb(payload)),
  // Tray "Settings…" -> toggle the in-window settings overlay.
  onToggleSettings: (cb) => ipcRenderer.on("toggle-settings", () => cb()),
  // claude-speak on/off, surfaced inside the settings panel.
  csEnabled: () => ipcRenderer.invoke("cs-enabled"),
  csSetEnabled: (v) => ipcRenderer.send("cs-set-enabled", v),
});
