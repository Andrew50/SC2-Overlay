import type { CompactBuildFile, ResolvedBuildGraph } from "../types";

export type ImportSourceFormat = "spawningtool-text" | "salt";

export type OpponentRace = "terran" | "zerg" | "protoss";

/**
 * One parsed line from an imported build order, normalized into the
 * vocabulary used by this project's compact builds.
 */
export interface ImportedStep {
  /** Original source line, untouched, for diagnostics. */
  raw: string;
  /** Canonical, repo-style action string (e.g. "2x Zergling", "Spawning Pool"). */
  action: string;
  /** Canonical base unit/structure/upgrade name used for matching (lowercased). */
  matchKey: string;
  /** Count when the source used an `xN` multiplier (default 1). */
  count: number;
  /** Trailing descriptive text the source attached to the action. */
  note?: string;
  /** Normalized "M:SS" timestamp if present. */
  time?: string;
  timeSeconds?: number;
  supply?: number;
  /** Worker units (SCV/Probe/Drone) — skipped during matching by default. */
  isWorker: boolean;
  /** Supply structures (Supply Depot/Overlord/Pylon) — matched carefully, never skipped. */
  isSupplyStructure: boolean;
}

export interface ParsedImport {
  format: ImportSourceFormat;
  /** Inferred player race, if it could be determined from the vocabulary. */
  race?: OpponentRace;
  /** Display name extracted from the source, if any. */
  name?: string;
  steps: ImportedStep[];
  warnings: string[];
}

export type MergeAction = "extend" | "add-decision-option" | "split-branch" | "new-root-child";

export interface MergeMatch {
  /** Index into collectBuildOrders(graph). */
  pathIndex: number;
  nodePath: string[];
  /** Length of the shared prefix (non-skipped imported steps that matched). */
  matchedStepCount: number;
  /** Resolved build-node id where the split happens. */
  divergeNodeId: string;
  /** Step index within that build node's action steps where divergence begins. */
  divergeStepIndex: number;
  score: number;
}

export interface MergeStepDiff {
  kind: "context" | "added";
  branchId: string;
  text: string;
}

export interface MergeDiff {
  addedBranches: string[];
  modifiedBranches: string[];
  steps: MergeStepDiff[];
}

export interface MergePlan {
  match: MergeMatch | null;
  action: MergeAction;
  newBranchId: string;
  decisionLabel: string;
  /** The proposed patched compact file (never mutates the input). */
  patchedCompact: CompactBuildFile;
  diff: MergeDiff;
  warnings: string[];
}

export interface MatchOptions {
  timeToleranceSec: number;
  supplyTolerance: number;
  skipWorkers: boolean;
}

/** Request shape sent from the viewer UI to the import service (browser-safe). */
export interface ImportPreviewRequest {
  text: string;
  /** Build id of the target file owning the race root (from raceOptions). */
  buildId: string;
  race?: OpponentRace;
  name?: string;
  apply?: boolean;
  keepWorkers?: boolean;
  timeToleranceSec?: number;
  supplyTolerance?: number;
}

/** Serializable result returned to the viewer UI (no functions). */
export interface ImportPreviewResponse {
  ok: boolean;
  error?: string;
  format?: ImportSourceFormat;
  race?: OpponentRace;
  name?: string;
  stepsParsed?: number;
  parserWarnings?: string[];
  action?: MergeAction;
  newBranchId?: string;
  matchedStepCount?: number | null;
  divergeNodeId?: string | null;
  divergeStepIndex?: number | null;
  diff?: MergeDiff;
  /**
   * Fully resolved graph of the proposed merge, so the viewer can render the
   * branch diff directly in the build graph. Present on a successful preview.
   */
  patchedGraph?: ResolvedBuildGraph;
  /** Root branch id used to resolve `patchedGraph` (the active race root). */
  rootBranchId?: string;
  planWarnings?: string[];
  validationErrors?: string[];
  applied?: boolean;
  targetFile?: string;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  timeToleranceSec: 3,
  supplyTolerance: 1,
  skipWorkers: true
};
