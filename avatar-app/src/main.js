// Claudette Avatar — a frameless, transparent, always-on-top desktop head that
// lip-syncs to whatever claude-speak speaks. claude-speak (its speak.sh) renders
// each reply to a WAV and POSTs it to this app's local bridge; the renderer plays
// it through a Web Audio analyser that drives the avatar's visemes. When this app
// isn't running, speak.sh just plays the audio itself (its normal behaviour).
//
// One embedded HTTP server does double duty: it serves the vendored avatar
// (so the avatar's `/vendor/...` import-map + ranged GLB fetches resolve) AND
// exposes POST /speak for the bridge. Same origin, no CORS.

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const express = require("express");

const PORT = parseInt(process.env.CLAUDETTE_AVATAR_PORT || "8456", 10);
const RENDERER = path.join(__dirname, "..", "renderer");
const ASSETS = path.join(__dirname, "..", "assets");

// Electron's Chromium blocks autoplay until a gesture; this app plays pushed audio
// with no user gesture, so opt out of the policy up front.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let win = null;
let tray = null;
let isQuitting = false;

// ---- claude-speak config (the single `enabled` flag, shared with control.sh) ----
const CS_CONFIG =
  process.env.CLAUDE_SPEAK_CONFIG ||
  path.join(os.homedir(), ".config", "claude-speak", "config.json");

function csRead() {
  try {
    return JSON.parse(fs.readFileSync(CS_CONFIG, "utf8"));
  } catch (_) {
    return {};
  }
}
// Missing file or missing key => claude-speak's own default is ON (speak.sh: `cfg enabled 1`).
function csEnabled() {
  const c = csRead();
  return c.enabled !== false;
}
function csSetEnabled(on) {
  const c = csRead();
  c.enabled = !!on;
  try {
    fs.mkdirSync(path.dirname(CS_CONFIG), { recursive: true });
    fs.writeFileSync(CS_CONFIG, JSON.stringify(c, null, 2) + "\n");
  } catch (e) {
    console.error("could not write claude-speak config:", e.message);
  }
}

// ---- embedded server: serves the avatar AND receives bridged speech ----
function startServer() {
  return new Promise((resolve, reject) => {
    const a = express();
    a.use(express.json({ limit: "96mb" })); // base64 WAV of a short reply is a few hundred KB

    a.get("/health", (_req, res) => res.json({ ok: true, app: "claudette-avatar" }));

    // claude-speak's speak.sh POSTs {b64, text, format} here; hand it to the renderer.
    a.post("/speak", (req, res) => {
      const { b64, text, format } = req.body || {};
      if (!b64) return res.status(400).json({ error: "missing b64 audio" });
      if (win && !win.isDestroyed()) {
        win.webContents.send("speak", { b64, text: text || "", format: format || "wav" });
      }
      res.json({ ok: true });
    });

    // The avatar module pulls face-rig anchors from the claudette server; we have none,
    // so answer empty (it `.catch`es a 404 fine, but this keeps the console clean).
    a.get("/api/face-anchors", (_req, res) => res.json({ empty: true }));

    a.use(express.static(RENDERER)); // index.html, /cc/*, /vendor/* (incl. ranged GLB)

    const server = http.createServer(a);
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---- the floating window ----
function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 450,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    title: "Claudette Avatar",
    icon: path.join(ASSETS, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep the render loop + lip-sync smooth when unfocused
    },
  });

  // Float above everything, on every Space, even over full-screen apps — and keep
  // re-asserting, because macOS will quietly demote even a screen-saver-level window.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setInterval(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, "screen-saver");
  }, 2500);

  win.loadURL(`http://127.0.0.1:${PORT}/`);

  // Surface renderer console/errors in the main stdout (handy for `npm start` debugging).
  win.webContents.on("console-message", (_e, _lvl, message, line, src) => {
    console.log(`[renderer] ${message}` + (src ? ` (${src}:${line})` : ""));
  });
  win.webContents.on("render-process-gone", (_e, d) => console.error("[renderer gone]", d.reason));

  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      requestQuit();
    }
  });
}

// ---- tray ----
function trayImage() {
  const img = nativeImage.createFromPath(path.join(ASSETS, "iconTemplate.png"));
  img.setTemplateImage(true);
  return img;
}
function buildTrayMenu() {
  const enabled = csEnabled();
  const visible = win && !win.isDestroyed() && win.isVisible();
  return Menu.buildFromTemplate([
    { label: visible ? "Hide avatar" : "Show avatar", click: toggleShow },
    { label: "Settings…", click: () => win && win.webContents.send("toggle-settings") },
    { label: "Recenter", click: recenter },
    { type: "separator" },
    {
      label: enabled ? "claude-speak voice: ON" : "claude-speak voice: OFF",
      click: () => {
        csSetEnabled(!enabled);
        refreshTray();
      },
    },
    { type: "separator" },
    { label: "Quit", click: requestQuit },
  ]);
}
function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}
function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip("Claudette Avatar");
  refreshTray();
  tray.on("click", () => tray.popUpContextMenu());
}

function toggleShow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else win.show();
  refreshTray();
}
function recenter() {
  if (!win || win.isDestroyed()) return;
  win.center();
  win.show();
}

// ---- quit flow: ask whether to also mute claude-speak ----
function requestQuit() {
  if (isQuitting) return;
  if (csEnabled()) {
    const choice = dialog.showMessageBoxSync(win || null, {
      type: "question",
      buttons: ["Turn off voice too", "Just close avatar", "Cancel"],
      defaultId: 1,
      cancelId: 2,
      message: "Quit Claudette Avatar?",
      detail:
        "claude-speak (the Claude Code voice) is ON. Closing the avatar lets claude-speak " +
        "go back to speaking through your speakers. Want to turn the voice off entirely too?",
    });
    if (choice === 2) return; // cancel
    if (choice === 0) csSetEnabled(false);
  }
  isQuitting = true;
  app.quit();
}

// ---- launch offer: enable claude-speak if it's off ----
function offerEnableOnLaunch() {
  if (csEnabled()) return;
  const choice = dialog.showMessageBoxSync(win || null, {
    type: "question",
    buttons: ["Turn on voice", "Not now"],
    defaultId: 0,
    cancelId: 1,
    message: "Turn on claude-speak?",
    detail:
      "claude-speak (the voice that reads Claude Code's replies) is currently OFF. " +
      "The avatar only moves its mouth while claude-speak is speaking. Turn it on now?",
  });
  if (choice === 0) {
    csSetEnabled(true);
    refreshTray();
  }
}

// ---- IPC from the renderer (settings panel voice toggle) ----
ipcMain.handle("cs-enabled", () => csEnabled());
ipcMain.on("cs-set-enabled", (_e, v) => {
  csSetEnabled(!!v);
  refreshTray();
});

// ---- lifecycle ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await startServer();
    } catch (e) {
      dialog.showErrorBox(
        "Claudette Avatar",
        `Could not start the local server on port ${PORT}.\n\n${e.message}\n\n` +
          `If something else is using the port, set CLAUDETTE_AVATAR_PORT and update ` +
          `claude-speak's avatar_port to match.`
      );
      app.quit();
      return;
    }
    createWindow();
    createTray();
    win.webContents.once("did-finish-load", offerEnableOnLaunch);
    if (process.platform === "darwin" && app.dock) app.dock.hide(); // menu-bar app, no dock tile
  });

  app.on("before-quit", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      requestQuit();
    }
  });

  // Tray app: don't quit just because the (only) window closed.
  app.on("window-all-closed", (e) => {
    if (!isQuitting) e.preventDefault && e.preventDefault();
  });
}
