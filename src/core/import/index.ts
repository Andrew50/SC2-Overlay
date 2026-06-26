import type { CompactBuildFile } from "../types";
import { resolveCompactFileToGraph, validateCompactBuild } from "../loader";
import { parseSpawningToolText } from "./parse-text";
import { decodeSalt } from "./parse-salt";
import { findMergePoint } from "./match";
import { planMerge, planNewBuild, type PlanMergeOptions } from "./merge";
import { DEFAULT_MATCH_OPTIONS } from "./types";
import type {
  ImportSourceFormat,
  MatchOptions,
  MergePlan,
  OpponentRace,
  ParsedImport
} from "./types";

export * from "./types";
export { parseSpawningToolText } from "./parse-text";
export { decodeSalt } from "./parse-salt";
export { findMergePoint } from "./match";
export { planMerge, planNewBuild } from "./merge";
export { normalizeAction, inferRace } from "./normalize";
export { renderMergeDiff } from "./diff";

export interface ImportOptions extends Partial<MatchOptions> {
  /** Build id used for resolving/validating the target file. */
  targetBuildId: string;
  /** Race root branch name in the target file (defaults to the inferred race). */
  rootBranchId?: string;
  /** Override the race when it cannot be inferred from the source. */
  race?: OpponentRace;
  /** Display name for the imported build (defaults to the parsed name). */
  importName?: string;
  /** Drop workers from the generated branch steps (default true). */
  outputSkipWorkers?: boolean;
}

export interface ImportResult {
  parsed: ParsedImport;
  plan: MergePlan;
  /** Errors from validating the patched compact file (empty when valid). */
  validationErrors: string[];
}

export function detectFormat(input: string): ImportSourceFormat {
  const trimmed = input.trim();
  // Spawning Tool SALT wrapper: "$<id>|<source>||<payload>"
  if (/^\$[^|]*\|[^|]*\|\|/.test(trimmed)) {
    return "salt";
  }
  // Generic SALT: "[version]title|author|desc|~<blocks>" on a single header line.
  const headerLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const tildeIndex = headerLine.indexOf("~");
  if (tildeIndex > 0) {
    const pipeCount = (headerLine.slice(0, tildeIndex).match(/\|/g) ?? []).length;
    if (pipeCount >= 2) {
      return "salt";
    }
  }
  return "spawningtool-text";
}

export function parseBuildOrder(input: string, format?: ImportSourceFormat): ParsedImport {
  const resolved = format ?? detectFormat(input);
  return resolved === "salt" ? decodeSalt(input) : parseSpawningToolText(input);
}

/**
 * End-to-end import: parse, match against the existing build, plan the merge,
 * and validate the proposed patch. Returns the plan for the author to apply.
 */
export function importBuildOrder(
  compact: CompactBuildFile,
  input: string,
  options: ImportOptions
): ImportResult {
  const parsed = parseBuildOrder(input);
  const race = options.race ?? parsed.race;
  if (!race) {
    throw new Error("Could not infer the build race; pass options.race explicitly.");
  }
  const rootBranchId = options.rootBranchId ?? race;

  const matchOptions: MatchOptions = {
    timeToleranceSec: options.timeToleranceSec ?? DEFAULT_MATCH_OPTIONS.timeToleranceSec,
    supplyTolerance: options.supplyTolerance ?? DEFAULT_MATCH_OPTIONS.supplyTolerance,
    skipWorkers: options.skipWorkers ?? DEFAULT_MATCH_OPTIONS.skipWorkers
  };

  const planOptions: PlanMergeOptions = {
    ...matchOptions,
    race,
    importName: options.importName ?? parsed.name ?? "Imported Build",
    outputSkipWorkers: options.outputSkipWorkers ?? true
  };

  // No existing root for this race (empty/new file): the import becomes the
  // race root directly, so there is nothing to merge against.
  if (!compact[rootBranchId]) {
    const plan = planNewBuild(compact, parsed.steps, planOptions);
    const validation = validateCompactBuild(plan.patchedCompact, {
      buildId: options.targetBuildId,
      rootBranchId,
      race
    });
    return { parsed, plan, validationErrors: validation.errors };
  }

  const graph = resolveCompactFileToGraph(compact, {
    buildId: options.targetBuildId,
    rootBranchId,
    race
  });

  const match = findMergePoint(graph, parsed.steps, matchOptions);

  const plan = planMerge(compact, graph, parsed.steps, match, planOptions);

  const validation = validateCompactBuild(plan.patchedCompact, {
    buildId: options.targetBuildId,
    rootBranchId,
    race
  });

  return { parsed, plan, validationErrors: validation.errors };
}
