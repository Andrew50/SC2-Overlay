import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
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
const electronMajor = Number.parseInt(process.versions.electron.split(".")[0] ?? "0", 10);

// Wayland handling for global shortcuts:
// - Electron 35+ supports the GlobalShortcuts portal.
// - Older Electron versions are more reliable under X11 fallback.
if (isLinuxWayland) {
  if (electronMajor >= 35) {
    app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
    app.commandLine.appendSwitch("ozone-platform", "wayland");
    console.log(
      `Wayland detected with Electron ${process.versions.electron}; using GlobalShortcutsPortal backend.`
    );
  } else {
    app.commandLine.appendSwitch("ozone-platform-hint", "x11");
    console.log(
      `Wayland detected with Electron ${process.versions.electron}; forcing X11 backend for global hotkeys.`
    );
  }
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

function clampWindowAxis(axis: number, size: number, min: number, span: number): number {
  const max = min + Math.max(0, span - size);
  return Math.min(Math.max(axis, min), max);
}

function resolveWindowPosition(config: AppConfig): { x?: number; y?: number } {
  if (typeof config.window.monitor !== "number") {
    return { x: config.window.x, y: config.window.y };
  }

  const displays = screen
    .getAllDisplays()
    .sort((a, b) => (a.bounds.x === b.bounds.x ? a.bounds.y - b.bounds.y : a.bounds.x - b.bounds.x));
  const requestedIndex = config.window.monitor - 1;
  const requestedDisplay = displays[requestedIndex];
  const targetDisplay = requestedDisplay ?? screen.getPrimaryDisplay();

  if (!requestedDisplay) {
    console.warn(
      `Requested monitor ${config.window.monitor} not found; falling back to primary display.`
    );
  }

  const { workArea } = targetDisplay;
  const desiredX =
    typeof config.window.x === "number"
      ? workArea.x + config.window.x
      : Math.round(workArea.x + (workArea.width - config.window.width) / 2);
  const desiredY =
    typeof config.window.y === "number"
      ? workArea.y + config.window.y
      : Math.round(workArea.y + (workArea.height - config.window.height) / 2);

  return {
    x: clampWindowAxis(desiredX, config.window.width, workArea.x, workArea.width),
    y: clampWindowAxis(desiredY, config.window.height, workArea.y, workArea.height)
  };
}

function createMainWindow(config: AppConfig): BrowserWindow {
  const position = resolveWindowPosition(config);
  const browserWindow = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    minWidth: config.window.minWidth,
    minHeight: config.window.minHeight,
    x: position.x,
    y: position.y,
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
