export type DisplayMode = "minimal" | "practice" | "review";
export type PlayerRace = "terran" | "zerg" | "protoss";
export type OpponentRace = "terran" | "zerg" | "protoss";

export interface HotkeyMap {
  left: string;
  middle: string;
  right: string;
  pause: string;
  reset: string;
  next: string;
}

export interface AppConfig {
  playerRace: PlayerRace;
  window: {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    monitor?: number;
    x?: number;
    y?: number;
    opacity: number;
    alwaysOnTop: boolean;
    transparent: boolean;
    frame: boolean;
    clickThrough: boolean;
  };
  hotkeys: {
    globalEnabled: boolean;
    global: HotkeyMap;
    focused: HotkeyMap;
  };
  timer: {
    adjustSeconds: number;
    presets: number[];
  };
  ui: {
    mode: DisplayMode;
    showNextCount: number;
    fontScale: number;
  };
  data: {
    buildsPath: string;
  };
}

export interface BuildFile {
  id: string;
  name: string;
  race: OpponentRace;
  metadata: Record<string, unknown>;
  imports?: BuildImport[];
  rootNodeId: string;
  nodes: Record<string, BuildNode>;
}

export interface CompactDecisionBranch {
  label: string;
  target: string;
}

export interface CompactStepDecision {
  "1": CompactDecisionBranch;
  "2": CompactDecisionBranch;
  "3"?: CompactDecisionBranch;
}

export interface CompactBuildStep {
  time?: string;
  supply?: number;
  action?: string;
  exact?: boolean;
  decision?: CompactStepDecision;
}

export interface CompactBranchEntry {
  steps: CompactBuildStep[];
}

export type CompactBuildFile = Record<string, CompactBranchEntry>;

export interface BuildImport {
  buildId: string;
  fromNodeId?: string;
  asPrefix?: string;
}

export interface BuildStep {
  time?: string;
  supply?: number;
  action: string;
  exact?: boolean;
}

export interface BuildNodeBase {
  type: "build" | "decision";
  title: string;
}

export interface BuildNodeEntry extends BuildNodeBase {
  type: "build";
  steps: BuildStep[];
  next?: string;
}

export interface DecisionBranch {
  label: string;
  target: string;
}

export interface DecisionNodeEntry extends BuildNodeBase {
  type: "decision";
  kind: "soft" | "hard";
  question: string;
  defaultBranch: "left";
  timeoutSeconds?: number;
  pauseTimer?: boolean;
  time?: string;
  supply?: number;
  left: DecisionBranch;
  middle: DecisionBranch;
  right?: DecisionBranch;
}

export type BuildNode = BuildNodeEntry | DecisionNodeEntry;

export interface ResolvedBuildGraph {
  id: string;
  name: string;
  race: OpponentRace;
  metadata: Record<string, unknown>;
  rootNodeId: string;
  nodes: Record<string, BuildNode>;
}

export type ControlAction = "left" | "middle" | "right" | "pause" | "reset" | "next";

export interface OpponentRaceOption {
  race: OpponentRace;
  buildId: string;
  label: string;
  graph: ResolvedBuildGraph;
}

export interface InitialAppData {
  config: AppConfig;
  raceOptions: OpponentRaceOption[];
}
