import type { ControlAction, InitialAppData, PracticeSessionConfig } from "./core/types";
import type { ImportPreviewRequest, ImportPreviewResponse } from "./core/import/types";

declare global {
  interface Window {
    overlayApi: {
      getInitialData: () => Promise<InitialAppData>;
      reloadData: () => Promise<InitialAppData>;
      importBuild: (request: ImportPreviewRequest) => Promise<ImportPreviewResponse>;
      openBuildsDirectory: () => Promise<string>;
      resizeOverlay: (height: number) => Promise<void>;
      toggleOverlayVisibility: () => Promise<boolean>;
      showOverlay: () => Promise<void>;
      hideOverlay: () => Promise<void>;
      isOverlayVisible: () => Promise<boolean>;
      openViewer: () => Promise<void>;
      startPractice: (config: PracticeSessionConfig) => Promise<void>;
      debugLog: (message: string, details?: unknown) => void;
      onControlAction: (callback: (action: ControlAction) => void) => () => void;
      onPracticeSession: (callback: (config: PracticeSessionConfig) => void) => () => void;
    };
  }
}

export {};
