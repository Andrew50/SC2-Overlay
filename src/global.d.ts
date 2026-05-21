import type { ControlAction, InitialAppData } from "./core/types";

declare global {
  interface Window {
    overlayApi: {
      getInitialData: () => Promise<InitialAppData>;
      reloadData: () => Promise<InitialAppData>;
      openBuildsDirectory: () => Promise<string>;
      toggleOverlayVisibility: () => Promise<boolean>;
      showOverlay: () => Promise<void>;
      hideOverlay: () => Promise<void>;
      isOverlayVisible: () => Promise<boolean>;
      debugLog: (message: string, details?: unknown) => void;
      onControlAction: (callback: (action: ControlAction) => void) => () => void;
    };
  }
}

export {};
