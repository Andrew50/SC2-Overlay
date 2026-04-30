import type { ControlAction, InitialAppData } from "./core/types";

declare global {
  interface Window {
    overlayApi: {
      getInitialData: () => Promise<InitialAppData>;
      reloadData: () => Promise<InitialAppData>;
      openBuildsDirectory: () => Promise<string>;
      toggleOverlayVisibility: () => Promise<boolean>;
      onControlAction: (callback: (action: ControlAction) => void) => () => void;
    };
  }
}

export {};
