import type { ControlAction, InitialAppData } from "./core/types";

declare global {
  interface Window {
    overlayApi: {
      getInitialData: () => Promise<InitialAppData>;
      onControlAction: (callback: (action: ControlAction) => void) => () => void;
    };
  }
}

export {};
