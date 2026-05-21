import { contextBridge, ipcRenderer } from "electron";
import type { ControlAction, InitialAppData } from "../src/core/types";

type UnsubscribeFn = () => void;

const api = {
  getInitialData: (): Promise<InitialAppData> => ipcRenderer.invoke("app:get-initial-data"),
  reloadData: (): Promise<InitialAppData> => ipcRenderer.invoke("app:reload-data"),
  openBuildsDirectory: (): Promise<string> => ipcRenderer.invoke("app:open-builds-directory"),
  toggleOverlayVisibility: (): Promise<boolean> => ipcRenderer.invoke("app:toggle-overlay-visibility"),
  showOverlay: (): Promise<void> => ipcRenderer.invoke("app:show-overlay"),
  hideOverlay: (): Promise<void> => ipcRenderer.invoke("app:hide-overlay"),
  isOverlayVisible: (): Promise<boolean> => ipcRenderer.invoke("app:is-overlay-visible"),
  debugLog: (message: string, details?: unknown): void => {
    ipcRenderer.send("app:debug-log", message, details);
  },
  onControlAction: (callback: (action: ControlAction) => void): UnsubscribeFn => {
    const listener = (_event: Electron.IpcRendererEvent, action: ControlAction) => {
      callback(action);
    };
    ipcRenderer.on("control-action", listener);
    return () => ipcRenderer.removeListener("control-action", listener);
  }
};

contextBridge.exposeInMainWorld("overlayApi", api);
