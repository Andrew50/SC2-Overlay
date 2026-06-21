import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } from "electron";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { loadInitialData } from "../src/core/loader";
import { runImport } from "../src/core/import/service";
import type { ImportPreviewRequest } from "../src/core/import/types";
import type { AppConfig, ControlAction, InitialAppData, PracticeSessionConfig } from "../src/core/types";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIST_INDEX = path.resolve(THIS_DIR, "../dist/index.html");
const RENDERER_DIST_VIEWER = path.resolve(THIS_DIR, "../dist/viewer.html");
const RENDERER_SOURCE_INDEX = path.resolve(THIS_DIR, "../src/index.html");
const PRELOAD_MJS = path.resolve(THIS_DIR, "preload.mjs");
const PRELOAD_JS = path.resolve(THIS_DIR, "preload.js");

let mainWindow: BrowserWindow | null = null;
let viewerWindow: BrowserWindow | null = null;
let initialData: InitialAppData | null = null;
let runtimeDataRoot = "";
let runtimeSchemaRoot = "";
const CHOOSE_REPEAT_GUARD_MS = 300;
const lastChooseBroadcastAtMs: Partial<Record<ControlAction, number>> = {};
const OVERLAY_REASSERT_DELAYS_MS = [0, 50, 250, 1000];
const OVERLAY_REASSERT_INTERVAL_MS = 2000;
let overlayReassertTimeouts: NodeJS.Timeout[] = [];
let overlayReassertInterval: NodeJS.Timeout | null = null;

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

function resolveViewerIndex(): string {
  return existsSync(RENDERER_DIST_VIEWER) ? RENDERER_DIST_VIEWER : path.resolve(THIS_DIR, "../viewer.html");
}

function broadcastControlAction(action: ControlAction): void {
  const now = Date.now();
  const isChooseAction = action === "choose1" || action === "choose2" || action === "choose3";
  const windowFocused = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
  const windowVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  if (isChooseAction) {
    const lastAt = lastChooseBroadcastAtMs[action];
    if (typeof lastAt === "number" && now - lastAt < CHOOSE_REPEAT_GUARD_MS) {
      console.log(
        `Suppressed repeated global shortcut callback for ${action} (${now - lastAt}ms < ${CHOOSE_REPEAT_GUARD_MS}ms) ` +
          `[focused=${windowFocused} visible=${windowVisible} now=${now}]`
      );
      return;
    }
    lastChooseBroadcastAtMs[action] = now;
  }
  console.log(
    `Global shortcut callback fired: ${action} [focused=${windowFocused} visible=${windowVisible} now=${now}]`
  );
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
    refreshOverlayReassertLoop();
    return false;
  }
  showMainWindow();
  return true;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  hideViewerWindow();
  showOverlayWindow(mainWindow);
}

function hideViewerWindow(): void {
  if (!viewerWindow || viewerWindow.isDestroyed()) {
    return;
  }
  viewerWindow.hide();
}

function hideMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.hide();
  refreshOverlayReassertLoop();
}

function clearOverlayReassertTimeouts(): void {
  for (const timeout of overlayReassertTimeouts) {
    clearTimeout(timeout);
  }
  overlayReassertTimeouts = [];
}

function stopOverlayReassertLoop(): void {
  if (!overlayReassertInterval) {
    return;
  }
  clearInterval(overlayReassertInterval);
  overlayReassertInterval = null;
}

function setOverlayAlwaysOnTop(window: BrowserWindow, enabled: boolean): void {
  if (process.platform === "win32" || process.platform === "darwin") {
    window.setAlwaysOnTop(enabled, enabled ? "screen-saver" : "normal");
    return;
  }
  window.setAlwaysOnTop(enabled);
}

function applyWindowOverlayOptions(window: BrowserWindow, config: AppConfig): void {
  if (config.window.clickThrough) {
    window.setIgnoreMouseEvents(true, { forward: true });
  } else {
    window.setIgnoreMouseEvents(false);
  }
  window.setOpacity(config.window.opacity);
  if (process.platform === "win32" || process.platform === "darwin") {
    window.setFocusable(false);
  }
  if (process.platform === "darwin") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setFullScreenable(false);
  } else if (process.platform === "linux") {
    window.setVisibleOnAllWorkspaces(true);
  }
  setOverlayAlwaysOnTop(window, config.window.alwaysOnTop);
}

function reassertOverlayWindow(reason: string): void {
  if (!mainWindow || mainWindow.isDestroyed() || !initialData || !mainWindow.isVisible()) {
    return;
  }
  applyWindowOverlayOptions(mainWindow, initialData.config);
  if (initialData.config.window.alwaysOnTop && !(process.platform === "linux" && isLinuxWayland)) {
    mainWindow.moveTop();
  }
  console.log(`Reasserted overlay window state (${reason}).`);
}

function scheduleOverlayReassert(reason: string): void {
  clearOverlayReassertTimeouts();
  for (const delayMs of OVERLAY_REASSERT_DELAYS_MS) {
    const timeout = setTimeout(() => {
      reassertOverlayWindow(`${reason}:${delayMs}ms`);
    }, delayMs);
    overlayReassertTimeouts.push(timeout);
  }
}

function refreshOverlayReassertLoop(): void {
  stopOverlayReassertLoop();
  if (!mainWindow || mainWindow.isDestroyed() || !initialData) {
    return;
  }
  if (!initialData.config.window.alwaysOnTop || !mainWindow.isVisible()) {
    return;
  }
  overlayReassertInterval = setInterval(() => {
    reassertOverlayWindow("interval");
  }, OVERLAY_REASSERT_INTERVAL_MS);
}

function showOverlayWindow(window: BrowserWindow): void {
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    if (process.platform === "linux" && isLinuxWayland) {
      window.show();
    } else {
      window.showInactive();
    }
  }
  scheduleOverlayReassert("show");
  refreshOverlayReassertLoop();
}

function attachOverlayWindowHandlers(window: BrowserWindow): void {
  const schedule = (reason: string): void => {
    scheduleOverlayReassert(reason);
    refreshOverlayReassertLoop();
  };

  window.on("show", () => schedule("show-event"));
  window.on("hide", () => {
    clearOverlayReassertTimeouts();
    refreshOverlayReassertLoop();
  });
  window.on("restore", () => schedule("restore"));
  window.on("blur", () => schedule("blur"));
  window.webContents.on("did-finish-load", () => schedule("did-finish-load"));
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
  attachOverlayWindowHandlers(browserWindow);
  return browserWindow;
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(resolveRendererIndex());
}

function createViewerWindow(): BrowserWindow {
  const browserWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreloadScript(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  browserWindow.on("closed", () => {
    if (viewerWindow === browserWindow) {
      viewerWindow = null;
    }
    showMainWindow();
  });

  return browserWindow;
}

async function loadViewer(window: BrowserWindow): Promise<void> {
  if (process.env.VITE_DEV_SERVER_URL) {
    const viewerUrl = new URL("/viewer.html", process.env.VITE_DEV_SERVER_URL).toString();
    await window.loadURL(viewerUrl);
    return;
  }
  await window.loadFile(resolveViewerIndex());
}

async function showViewerWindow(): Promise<void> {
  if (!initialData) {
    throw new Error("App data is not loaded");
  }

  hideMainWindow();

  if (!viewerWindow || viewerWindow.isDestroyed()) {
    viewerWindow = createViewerWindow();
    await loadViewer(viewerWindow);
  }

  if (viewerWindow.isMinimized()) {
    viewerWindow.restore();
  }
  viewerWindow.show();
  viewerWindow.focus();
}

function registerGlobalHotkeys(config: AppConfig): void {
  globalShortcut.unregisterAll();

  if (!config.hotkeys.globalEnabled) {
    console.log("Global hotkeys are disabled in config.hotkeys.globalEnabled.");
    return;
  }

  const hotkeyMap: Record<ControlAction, string> = {
    choose1: config.hotkeys.global.choose1,
    choose2: config.hotkeys.global.choose2,
    choose3: config.hotkeys.global.choose3,
    reset: config.hotkeys.global.reset,
    jumpForward: config.hotkeys.global.jumpForward,
    jumpBackward: config.hotkeys.global.jumpBackward,
    jumpPrevious: config.hotkeys.global.jumpPrevious,
    jumpNext: config.hotkeys.global.jumpNext,
    pause: config.hotkeys.global.pause ?? ""
  };
  const toggleVisibilityAccelerator = config.hotkeys.global.toggleVisibility ?? "";
  const openViewerAccelerator = config.hotkeys.global.openViewer ?? "";
  console.log(
    `Global hotkey config: ${inspect(
      {
        choose1: hotkeyMap.choose1,
        choose2: hotkeyMap.choose2,
        choose3: hotkeyMap.choose3,
        reset: hotkeyMap.reset,
        jumpForward: hotkeyMap.jumpForward,
        jumpBackward: hotkeyMap.jumpBackward,
        jumpPrevious: hotkeyMap.jumpPrevious,
        jumpNext: hotkeyMap.jumpNext,
        pause: hotkeyMap.pause,
        toggleVisibility: toggleVisibilityAccelerator,
        openViewer: openViewerAccelerator
      },
      { compact: true }
    )}`
  );

  const isGnomeWayland =
    isLinuxWayland && (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().includes("gnome");
  const hasBareFunctionKeys = [...Object.values(hotkeyMap), toggleVisibilityAccelerator, openViewerAccelerator].some(
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

  if (openViewerAccelerator) {
    const ok = globalShortcut.register(openViewerAccelerator, () => {
      void showViewerWindow();
    });
    if (!ok) {
      console.warn(
        `Failed to register global shortcut for openViewer: ${openViewerAccelerator}. ` +
          "This often means the key is reserved by the OS or desktop environment."
      );
    } else {
      console.log(`Registered global shortcut for openViewer: ${openViewerAccelerator}`);
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

function restoreBundledDefaults(userDataRoot: string, bundledDefaultsRoot: string, reason: unknown): void {
  const sourceConfigPath = path.join(bundledDefaultsRoot, "config.json");
  const sourceBuildsPath = path.join(bundledDefaultsRoot, "builds");
  const targetConfigPath = path.join(userDataRoot, "config.json");
  const targetBuildsPath = path.join(userDataRoot, "builds");
  const syncVersionMarkerPath = path.join(userDataRoot, ".defaults-sync-version");
  const currentVersion = app.getVersion();
  const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = path.join(userDataRoot, "backups", `recovery_${currentVersion}_${backupStamp}`);

  console.error("Runtime data failed to load; restoring bundled defaults.", reason);

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
  scheduleOverlayReassert("config-reload");
  refreshOverlayReassertLoop();
}

function reloadAppData(): InitialAppData {
  initialData = loadInitialData();
  applyDynamicConfig(initialData.config);
  return initialData;
}

function reloadAppDataWithPackagedRecovery(): InitialAppData {
  try {
    return reloadAppData();
  } catch (error) {
    if (!app.isPackaged) {
      throw error;
    }

    const userDataRoot = resolvePackagedDataRoot();
    const bundledDefaultsRoot = resolveBundledDefaultsRoot(app.getAppPath());
    restoreBundledDefaults(userDataRoot, bundledDefaultsRoot, error);
    return reloadAppData();
  }
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
  ipcMain.handle("app:show-overlay", () => {
    showMainWindow();
  });
  ipcMain.handle("app:hide-overlay", () => {
    hideMainWindow();
  });
  ipcMain.handle("app:open-viewer", async () => {
    await showViewerWindow();
  });
  ipcMain.handle("app:start-practice", (_event, config: PracticeSessionConfig) => {
    hideViewerWindow();
    showMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send("practice-session", config);
  });
  ipcMain.handle("app:is-overlay-visible", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return false;
    }
    return mainWindow.isVisible();
  });
  ipcMain.handle("app:import-build", async (_event, request: ImportPreviewRequest) => {
    const buildsPath = resolveBuildsDirectoryPath();
    const result = runImport(buildsPath, request);
    if (result.applied) {
      await reloadAppData();
    }
    return result;
  });
  ipcMain.handle("app:open-builds-directory", async () => {
    const buildsDirectoryPath = resolveBuildsDirectoryPath();
    const openError = await shell.openPath(buildsDirectoryPath);
    if (openError) {
      throw new Error(openError);
    }
    return buildsDirectoryPath;
  });
  ipcMain.handle("app:resize-overlay", (_event, requestedHeight: number) => {
    if (!mainWindow || mainWindow.isDestroyed() || !initialData) {
      return;
    }
    const nextHeight = Math.max(
      initialData.config.window.minHeight,
      Math.ceil(Number.isFinite(requestedHeight) ? requestedHeight : initialData.config.window.height)
    );
    const [currentWidth, currentHeight] = mainWindow.getContentSize();
    if (currentHeight === nextHeight) {
      return;
    }
    mainWindow.setContentSize(currentWidth, nextHeight);
  });
  ipcMain.on("app:debug-log", (_event, message: string, details?: unknown) => {
    if (typeof details === "undefined") {
      console.log(`[renderer-debug] ${message}`);
      return;
    }
    console.log(`[renderer-debug] ${message} ${inspect(details, { depth: 6, breakLength: 120 })}`);
  });
}

async function bootstrap(): Promise<void> {
  const runtimePaths = prepareRuntimePaths();
  runtimeDataRoot = runtimePaths.dataRoot;
  runtimeSchemaRoot = runtimePaths.schemaRoot;
  process.env.SC2_OVERLAY_APP_ROOT = runtimeDataRoot;
  process.env.SC2_OVERLAY_SCHEMA_ROOT = runtimeSchemaRoot;
  initialData = reloadAppDataWithPackagedRecovery();
  mainWindow = createMainWindow(initialData.config);
  setupIpc();
  await loadRenderer(mainWindow);
  refreshOverlayReassertLoop();
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
  showMainWindow();
});

app.on("will-quit", () => {
  clearOverlayReassertTimeouts();
  stopOverlayReassertLoop();
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
