// Electron main process: a tray app that runs the TV daemon in the background and shows its
// log stream in a window. Closing the window hides it to the tray; the daemon keeps running.
// Quit from the tray menu (or the window's Quit button) to actually exit.
//
// The window only *displays* logs and offers the two actions as buttons — all the real work is
// the daemon core (src/daemon-core.ts), which registers the global hotkeys and drives the TV.
// Logs reach the window by subscribing to the logger's onLog() and forwarding each line over
// IPC; a bounded backlog is kept so a freshly-opened window can render history.

import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon, ON_COMBO_LABEL, OFF_COMBO_LABEL, type Daemon } from "../daemon-core.js";
import { createApp } from "../app.js";
import { onLog, log, logError, type LogEntry } from "../log.js";
import { getAuthStatus, login as runLogin, logout as runLogout, LOGIN_CANCELLED } from "./auth.js";
import { getSettings, saveSettings, type AppSettings } from "./settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Packaged apps live in a read-only asar archive, so the SmartThings config (OAuth tokens) can't
// be written next to the bundled source. Redirect it to a writable folder: next to the .exe for a
// portable build, otherwise the per-user data dir. config.ts reads this env var lazily, so setting
// it here — before any loadConfig/saveConfig — is enough. An explicit env override still wins.
// In dev (unpackaged) we leave the default so the Electron app shares the repo's config file.
if (app.isPackaged && !process.env.SMARTTHINGS_CONFIG_PATH) {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR ?? app.getPath("userData");
  process.env.SMARTTHINGS_CONFIG_PATH = path.join(dir, "smartthings-config.json");
}

// Bounded in-memory backlog so a window opened after startup still shows prior output.
const MAX_HISTORY = 2000;
const history: LogEntry[] = [];

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let daemon: Daemon | null = null;
let quitting = false;
// Mirrors config.minimizeToTrayOnClose; loaded once at startup and updated when Settings saves.
// When false, closing the window quits the app instead of hiding to the tray.
let minimizeToTrayOnClose = true;

function pushHistory(entry: LogEntry): void {
  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 860,
    height: 580,
    minWidth: 700,
    minHeight: 500,
    title: "Samsung TV Control",
    icon: nativeImage.createFromPath(path.join(__dirname, "icon.png")),
    backgroundColor: "#0d1117",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void w.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Closing the window hides it to the tray (the daemon stays alive) when that preference is on;
  // otherwise closing quits the app. The quitting flag lets the tray Quit / before-quit pass.
  w.on("close", (e) => {
    if (quitting) return;
    if (minimizeToTrayOnClose) {
      e.preventDefault();
      w.hide();
    } else {
      quitting = true;
      app.quit();
    }
  });

  return w;
}

function showWindow(): void {
  if (!win || win.isDestroyed()) win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function sendLog(entry: LogEntry): void {
  if (win && !win.isDestroyed()) win.webContents.send("log", entry);
}

// Surface the window and tell the renderer to open the Settings modal.
function openSettings(): void {
  showWindow();
  win?.webContents.send("open-settings");
}

function buildTray(): void {
  // Tray glyph (a switch/toggle) is generated at build time from one source — see
  // renderSwitchIcon in scripts/build-electron.mjs. macOS loads the black silhouette and marks it
  // a template image so the system recolors it to match the menu bar (white on dark, inverting on
  // click). Windows ignores template images, so there we load the white silhouette directly — it
  // shows white on the (typically dark) taskbar. The 16px base + @2x are auto-loaded by name; the
  // 150% (24px) size is added explicitly below since Electron's @Nx convention skips 1.5x.
  const isMac = process.platform === "darwin";
  const trayImg = nativeImage.createFromPath(
    path.join(__dirname, isMac ? "tray.png" : "tray-white.png"),
  );
  if (isMac) {
    trayImg.setTemplateImage(true);
  } else {
    // The notification-area slot is 16 DIP scaled by display DPI: 16px @100%, 24px @150%, 32px
    // @200%. Electron's @2x filename convention only covers integer scales (1x/2x), so the 150%
    // size — the most common Win 11 laptop scaling — must be attached as an explicit 1.5x
    // representation; otherwise Windows downscales the 32px and the thin glyph looks soft.
    trayImg.addRepresentation({
      scaleFactor: 1.5,
      buffer: nativeImage
        .createFromPath(path.join(__dirname, "tray-white@1.5x.png"))
        .toPNG(),
    });
  }
  tray = new Tray(trayImg);
  tray.setToolTip("Samsung TV Control");
  const menu = Menu.buildFromTemplate([
    { label: "Show logs", click: () => showWindow() },
    { label: "Settings…", click: () => openSettings() },
    { type: "separator" },
    { label: `Wake TV + switch to PC  (${ON_COMBO_LABEL})`, click: () => void daemon?.triggerOn() },
    { label: `TV off + sleep this PC  (${OFF_COMBO_LABEL})`, click: () => void daemon?.triggerOffAndSleep() },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  // Double-click (Windows) / click toggles the log window.
  tray.on("double-click", () => showWindow());
  tray.on("click", () => showWindow());
}

async function start(): Promise<void> {
  // Force dark app appearance so the native macOS title bar (and other system chrome) is drawn
  // dark to match the window's black UI, rather than following the OS's light/dark setting.
  nativeTheme.themeSource = "dark";
  Menu.setApplicationMenu(null);
  // Load the close-to-tray preference before the window can be closed.
  minimizeToTrayOnClose = (await getSettings()).minimizeToTrayOnClose;
  buildTray();
  win = createWindow();

  // Subscribe BEFORE starting the daemon so its startup banner lands in the backlog.
  onLog((entry) => {
    pushHistory(entry);
    sendLog(entry);
  });

  ipcMain.handle("log:history", () => history);
  ipcMain.on("log:clear", () => {
    history.length = 0;
  });
  ipcMain.on("action:on", () => void daemon?.triggerOn());
  ipcMain.on("action:off", () => void daemon?.triggerOffAndSleep());

  // Auth: the GUI equivalent of `npm run login` / `npm run reset`. The daemon reloads config on
  // every action, so newly-saved tokens take effect on the next Wake without a restart.
  ipcMain.handle("auth:status", () => getAuthStatus());
  ipcMain.handle("auth:login", async () => {
    try {
      const result = await runLogin(win);
      if (result === LOGIN_CANCELLED) {
        return { ok: false as const, cancelled: true as const };
      }
      log("\n✅ Signed in to SmartThings — tokens saved and will refresh automatically.");
      return { ok: true as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  });
  ipcMain.handle("auth:logout", async () => {
    await runLogout();
    log("Signed out — cleared stored SmartThings credentials.");
    return { ok: true as const };
  });

  // Settings: edit user preferences (pcInput, close-to-tray) without hand-editing the config file.
  // The daemon reloads config per action, so a new pcInput applies on the next Wake; the tray flag
  // is mirrored here so it takes effect on the next close without a restart.
  // List the account's TVs for the Settings selection list. Builds its own app instance (each
  // handler call reloads config + token), independent of the daemon. Returns a tagged result so
  // the renderer can show a friendly message when the user isn't signed in or the cloud call fails.
  ipcMain.handle("devices:list", async () => {
    // Not signed in yet → return a clean "not authorized" result rather than letting listTVs()
    // throw the CLI-oriented "run `npm run login`" message at the GUI. The renderer shows its own
    // "Sign in to load your TVs." prompt for this case.
    if (!(await getAuthStatus()).authorized) {
      return { ok: false as const, error: "", notAuthorized: true as const };
    }
    try {
      const devices = await createApp().listTVs();
      return { ok: true as const, devices };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:save", async (_e, partial: Partial<AppSettings>) => {
    await saveSettings(partial);
    const next = await getSettings();
    minimizeToTrayOnClose = next.minimizeToTrayOnClose;
    // Apply changed hotkey combos to the running daemon without a restart.
    daemon?.reloadHotkeys();
    return { ok: true as const };
  });

  try {
    daemon = await startDaemon();
  } catch (err) {
    // Route through logError so the line gets an id and flows through the normal onLog fan-out
    // (which already does pushHistory + sendLog), keeping it deduplicatable like every other line.
    logError(`Failed to start daemon: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Single instance: a second launch just surfaces the existing window rather than starting a
// second daemon (the first instance already holds the global-shortcut registrations; a second
// would fail to register them and the two daemons would otherwise both act on the TV).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(start);

  // Tray app: keep running after the window is closed; only the tray Quit exits.
  app.on("window-all-closed", () => {
    /* stay alive in the tray */
  });

  app.on("before-quit", () => {
    quitting = true;
    daemon?.stop();
  });
}
