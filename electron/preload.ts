import { contextBridge, ipcRenderer } from "electron";
import type { ControlAction, InitialAppData, PracticeSessionConfig } from "../src/core/types";
import type { ImportPreviewRequest, ImportPreviewResponse } from "../src/core/import/types";
import type { SetBranchDisabledRequest, SetBranchDisabledResponse } from "../src/core/branch-state/types";
import type {
  UpdateDecisionLabelRequest,
  UpdateDecisionLabelResponse
} from "../src/core/update-decision-label/types";

type UnsubscribeFn = () => void;

const api = {
  getInitialData: (): Promise<InitialAppData> => ipcRenderer.invoke("app:get-initial-data"),
  reloadData: (): Promise<InitialAppData> => ipcRenderer.invoke("app:reload-data"),
  importBuild: (request: ImportPreviewRequest): Promise<ImportPreviewResponse> =>
    ipcRenderer.invoke("app:import-build", request),
  setBranchDisabled: (request: SetBranchDisabledRequest): Promise<SetBranchDisabledResponse> =>
    ipcRenderer.invoke("app:set-branch-disabled", request),
  updateDecisionLabel: (request: UpdateDecisionLabelRequest): Promise<UpdateDecisionLabelResponse> =>
    ipcRenderer.invoke("app:update-decision-label", request),
  openBuildsDirectory: (): Promise<string> => ipcRenderer.invoke("app:open-builds-directory"),
  resizeOverlay: (height: number): Promise<void> => ipcRenderer.invoke("app:resize-overlay", height),
  toggleOverlayVisibility: (): Promise<boolean> => ipcRenderer.invoke("app:toggle-overlay-visibility"),
  showOverlay: (): Promise<void> => ipcRenderer.invoke("app:show-overlay"),
  hideOverlay: (): Promise<void> => ipcRenderer.invoke("app:hide-overlay"),
  isOverlayVisible: (): Promise<boolean> => ipcRenderer.invoke("app:is-overlay-visible"),
  openViewer: (): Promise<void> => ipcRenderer.invoke("app:open-viewer"),
  startPractice: (config: PracticeSessionConfig): Promise<void> =>
    ipcRenderer.invoke("app:start-practice", config),
  debugLog: (message: string, details?: unknown): void => {
    ipcRenderer.send("app:debug-log", message, details);
  },
  onControlAction: (callback: (action: ControlAction) => void): UnsubscribeFn => {
    const listener = (_event: Electron.IpcRendererEvent, action: ControlAction) => {
      callback(action);
    };
    ipcRenderer.on("control-action", listener);
    return () => ipcRenderer.removeListener("control-action", listener);
  },
  onPracticeSession: (callback: (config: PracticeSessionConfig) => void): UnsubscribeFn => {
    const listener = (_event: Electron.IpcRendererEvent, config: PracticeSessionConfig) => {
      callback(config);
    };
    ipcRenderer.on("practice-session", listener);
    return () => ipcRenderer.removeListener("practice-session", listener);
  },
  onDataUpdated: (callback: (data: InitialAppData) => void): UnsubscribeFn => {
    const listener = (_event: Electron.IpcRendererEvent, data: InitialAppData) => {
      callback(data);
    };
    ipcRenderer.on("data-updated", listener);
    return () => ipcRenderer.removeListener("data-updated", listener);
  }
};

contextBridge.exposeInMainWorld("overlayApi", api);
