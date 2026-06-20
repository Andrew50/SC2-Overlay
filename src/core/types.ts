export type DisplayMode = "minimal" | "practice" | "review";
export type PlayerRace = "terran" | "zerg" | "protoss";
export type OpponentRace = "terran" | "zerg" | "protoss";

export interface HotkeyMap {
  choose1: string;
  choose2: string;
  choose3: string;
  reset: string;
  jumpForward: string;
  jumpBackward: string;
  jumpPrevious: string;
  jumpNext: string;
  pause?: string;
  toggleVisibility?: string;
}

export interface AppConfig {
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
    decisionTimeoutSeconds: number;
    entryGraceSeconds: number;
  };
  ui: {
    mode: DisplayMode;
    showNextCount: number;
    fontScale: number;
    scale: number;
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
  steps?: CompactBuildStep[];
  target?: string;
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

export type ControlAction =
  | "choose1"
  | "choose2"
  | "choose3"
  | "pause"
  | "reset"
  | "jumpForward"
  | "jumpBackward"
  | "jumpPrevious"
  | "jumpNext";

export interface PlayerRaceOption {
  playerRace: PlayerRace;
  buildId: string;
  label: string;
  graph: ResolvedBuildGraph;
}

export interface InitialAppData {
  config: AppConfig;
  raceOptions: PlayerRaceOption[];
}

export type DecisionBranchKey = "left" | "middle" | "right";

export interface PracticeSessionConfig {
  playerRace: PlayerRace;
  rememberedChoices: Record<string, DecisionBranchKey>;
  branchLabel: string;
}
