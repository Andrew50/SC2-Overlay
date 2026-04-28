import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadInitialData } from "../src/core/loader";
import type { AppConfig, ControlAction, InitialAppData } from "../src/core/types";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIST_INDEX = path.resolve(THIS_DIR, "../dist/index.html");
const RENDERER_SOURCE_INDEX = path.resolve(THIS_DIR, "../src/index.html");
const PRELOAD_MJS = path.resolve(THIS_DIR, "preload.mjs");
const PRELOAD_JS = path.resolve(THIS_DIR, "preload.js");

let mainWindow: BrowserWindow | null = null;
let initialData: InitialAppData | null = null;

const isLinuxWayland = process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland";

// Wayland compositors often block or reserve bare global F-keys.
// For Linux Wayland sessions, prefer running Electron on X11 backend.
if (isLinuxWayland) {
  app.commandLine.appendSwitch("ozone-platform-hint", "x11");
  console.log("Wayland detected; forcing Electron to X11 backend for global F-key hotkeys.");
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  console.log("Another instance is already running; exiting this instance.");
  app.quit();
}

function resolvePreloadScript(): string {
  return existsSync(PRELOAD_MJS) ? PRELOAD_MJS : PRELOAD_JS;
}

function resolveRendererIndex(): string {
  return existsSync(RENDERER_DIST_INDEX) ? RENDERER_DIST_INDEX : RENDERER_SOURCE_INDEX;
}

function broadcastControlAction(action: ControlAction): void {
  console.log(`Global shortcut callback fired: ${action}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("control-action", action);
  }
}

function applyWindowOverlayOptions(window: BrowserWindow, config: AppConfig): void {
  if (config.window.clickThrough) {
    window.setIgnoreMouseEvents(true, { forward: true });
  }
  window.setOpacity(config.window.opacity);
}

function createMainWindow(config: AppConfig): BrowserWindow {
  const browserWindow = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    minWidth: config.window.minWidth,
    minHeight: config.window.minHeight,
    x: config.window.x,
    y: config.window.y,
    frame: config.window.frame,
    transparent: config.window.transparent,
    alwaysOnTop: config.window.alwaysOnTop,
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreloadScript(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  applyWindowOverlayOptions(browserWindow, config);
  return browserWindow;
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(resolveRendererIndex());
}

function registerGlobalHotkeys(config: AppConfig): void {
  if (!config.hotkeys.globalEnabled) {
    console.log("Global hotkeys are disabled in config.hotkeys.globalEnabled.");
    return;
  }

  const hotkeyMap: Record<ControlAction, string> = {
    left: config.hotkeys.global.left,
    middle: config.hotkeys.global.middle,
    right: config.hotkeys.global.right,
    pause: config.hotkeys.global.pause,
    reset: config.hotkeys.global.reset,
    next: config.hotkeys.global.next
  };

  for (const [action, accelerator] of Object.entries(hotkeyMap) as Array<[ControlAction, string]>) {
    if (!accelerator) {
      continue;
    }
    const ok = globalShortcut.register(accelerator, () => broadcastControlAction(action));
    if (!ok) {
      console.warn(
        `Failed to register global shortcut for ${action}: ${accelerator}. ` +
          "This often means the key is reserved by the OS or desktop environment."
      );
    } else {
      console.log(`Registered global shortcut for ${action}: ${accelerator}`);
    }
  }
}

function setupIpc(): void {
  ipcMain.handle("app:get-initial-data", () => {
    if (!initialData) {
      throw new Error("App data is not loaded");
    }
    return initialData;
  });
}

async function bootstrap(): Promise<void> {
  process.env.SC2_OVERLAY_APP_ROOT = app.getAppPath();
  initialData = loadInitialData();
  mainWindow = createMainWindow(initialData.config);
  setupIpc();
  registerGlobalHotkeys(initialData.config);
  await loadRenderer(mainWindow);
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }

  bootstrap().catch((error) => {
    console.error("Fatal bootstrap error:", error);
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && initialData) {
      mainWindow = createMainWindow(initialData.config);
      loadRenderer(mainWindow).catch((error) => {
        console.error("Failed to load renderer during activation:", error);
      });
    }
  });
});

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
