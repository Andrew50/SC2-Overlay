import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } from "electron";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
let runtimeDataRoot = "";
let runtimeSchemaRoot = "";

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

function toggleMainWindowVisibility(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return false;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  return true;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
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
  globalShortcut.unregisterAll();

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
  const toggleVisibilityAccelerator = config.hotkeys.global.toggleVisibility;

  const isGnomeWayland =
    isLinuxWayland && (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().includes("gnome");
  const hasBareFunctionKeys = [...Object.values(hotkeyMap), toggleVisibilityAccelerator].some(
    (accelerator) => /^f\d{1,2}$/i.test(accelerator)
  );
  if (isGnomeWayland && hasBareFunctionKeys) {
    console.warn(
      "GNOME Wayland typically blocks bare F-key global shortcuts via portal APIs. " +
        "Use modified accelerators (e.g. Ctrl+Alt+F1) or run an Xorg session for global F1-F12."
    );
  }

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

  if (toggleVisibilityAccelerator) {
    const ok = globalShortcut.register(toggleVisibilityAccelerator, () => {
      const isVisible = toggleMainWindowVisibility();
      console.log(`Overlay visibility toggled via global hotkey: ${isVisible ? "shown" : "hidden"}`);
    });
    if (!ok) {
      console.warn(
        `Failed to register global shortcut for toggleVisibility: ${toggleVisibilityAccelerator}. ` +
          "This often means the key is reserved by the OS or desktop environment."
      );
    } else {
      console.log(`Registered global shortcut for toggleVisibility: ${toggleVisibilityAccelerator}`);
    }
  }
}

function resolvePackagedDataRoot(): string {
  return path.join(app.getPath("userData"), "data");
}

function resolveBundledDefaultsRoot(bundledRoot: string): string {
  if (!app.isPackaged) {
    return bundledRoot;
  }
  return path.join(process.resourcesPath, "defaults");
}

function copyPathIfMissing(sourcePath: string, targetPath: string): void {
  if (existsSync(targetPath) || !existsSync(sourcePath)) {
    return;
  }
  cpSync(sourcePath, targetPath, { recursive: true });
}

function movePathToBackup(sourcePath: string, backupPath: string): void {
  if (!existsSync(sourcePath)) {
    return;
  }
  mkdirSync(path.dirname(backupPath), { recursive: true });
  try {
    renameSync(sourcePath, backupPath);
  } catch {
    cpSync(sourcePath, backupPath, { recursive: true });
    rmSync(sourcePath, { recursive: true, force: true });
  }
}

function syncDefaultsOnVersionChange(userDataRoot: string, bundledDefaultsRoot: string): void {
  const syncVersionMarkerPath = path.join(userDataRoot, ".defaults-sync-version");
  const currentVersion = app.getVersion();
  const hasSyncedForCurrentVersion =
    existsSync(syncVersionMarkerPath) &&
    process.env.SC2_OVERLAY_DEFAULTS_SYNC_FORCE !== "1" &&
    (() => {
      try {
        return readFileSync(syncVersionMarkerPath, "utf8").trim() === currentVersion;
      } catch {
        return false;
      }
    })();

  if (hasSyncedForCurrentVersion) {
    return;
  }

  const sourceConfigPath = path.join(bundledDefaultsRoot, "config.json");
  const sourceBuildsPath = path.join(bundledDefaultsRoot, "builds");
  const targetConfigPath = path.join(userDataRoot, "config.json");
  const targetBuildsPath = path.join(userDataRoot, "builds");

  const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = path.join(userDataRoot, "backups", `${currentVersion}_${backupStamp}`);

  if (existsSync(targetConfigPath)) {
    movePathToBackup(targetConfigPath, path.join(backupRoot, "config.json"));
  }
  if (existsSync(targetBuildsPath)) {
    movePathToBackup(targetBuildsPath, path.join(backupRoot, "builds"));
  }

  copyPathIfMissing(sourceConfigPath, targetConfigPath);
  copyPathIfMissing(sourceBuildsPath, targetBuildsPath);

  mkdirSync(path.dirname(syncVersionMarkerPath), { recursive: true });
  writeFileSync(syncVersionMarkerPath, currentVersion, "utf8");
}

function prepareRuntimePaths(): { dataRoot: string; schemaRoot: string } {
  const envRoot = process.env.SC2_OVERLAY_APP_ROOT?.trim();
  const envSchemaRoot = process.env.SC2_OVERLAY_SCHEMA_ROOT?.trim();
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    return { dataRoot: resolved, schemaRoot: envSchemaRoot ? path.resolve(envSchemaRoot) : resolved };
  }

  const bundledRoot = app.getAppPath();
  const bundledDefaultsRoot = resolveBundledDefaultsRoot(bundledRoot);
  if (!app.isPackaged) {
    return { dataRoot: bundledRoot, schemaRoot: bundledRoot };
  }

  const userDataRoot = resolvePackagedDataRoot();
  mkdirSync(userDataRoot, { recursive: true });
  syncDefaultsOnVersionChange(userDataRoot, bundledDefaultsRoot);
  copyPathIfMissing(path.join(bundledDefaultsRoot, "config.json"), path.join(userDataRoot, "config.json"));
  copyPathIfMissing(path.join(bundledDefaultsRoot, "builds"), path.join(userDataRoot, "builds"));
  console.log(`Using runtime data root: ${userDataRoot}`);
  return { dataRoot: userDataRoot, schemaRoot: bundledRoot };
}

function applyDynamicConfig(config: AppConfig): void {
  registerGlobalHotkeys(config);
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  applyWindowOverlayOptions(mainWindow, config);
}

function reloadAppData(): InitialAppData {
  initialData = loadInitialData();
  applyDynamicConfig(initialData.config);
  return initialData;
}

function resolveBuildsDirectoryPath(): string {
  if (!initialData) {
    throw new Error("App data is not loaded");
  }
  return path.resolve(runtimeDataRoot, initialData.config.data.buildsPath);
}

function setupIpc(): void {
  ipcMain.handle("app:get-initial-data", () => {
    if (!initialData) {
      throw new Error("App data is not loaded");
    }
    return initialData;
  });
  ipcMain.handle("app:reload-data", () => reloadAppData());
  ipcMain.handle("app:toggle-overlay-visibility", () => toggleMainWindowVisibility());
  ipcMain.handle("app:show-overlay", () => showMainWindow());
  ipcMain.handle("app:open-builds-directory", async () => {
    const buildsDirectoryPath = resolveBuildsDirectoryPath();
    const openError = await shell.openPath(buildsDirectoryPath);
    if (openError) {
      throw new Error(openError);
    }
    return buildsDirectoryPath;
  });
}

async function bootstrap(): Promise<void> {
  const runtimePaths = prepareRuntimePaths();
  runtimeDataRoot = runtimePaths.dataRoot;
  runtimeSchemaRoot = runtimePaths.schemaRoot;
  process.env.SC2_OVERLAY_APP_ROOT = runtimeDataRoot;
  process.env.SC2_OVERLAY_SCHEMA_ROOT = runtimeSchemaRoot;
  initialData = reloadAppData();
  mainWindow = createMainWindow(initialData.config);
  setupIpc();
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
