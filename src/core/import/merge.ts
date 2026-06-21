import type {
  CompactBranchEntry,
  CompactBuildFile,
  CompactBuildStep,
  CompactStepDecision,
  ResolvedBuildGraph
} from "../types";
import { actionForOutput } from "./normalize";
import { computeMergeDiff } from "./diff";
import type { ImportedStep, MatchOptions, MergeMatch, MergePlan, OpponentRace } from "./types";

export interface PlanMergeOptions extends MatchOptions {
  race: OpponentRace;
  /** Display name for the imported build (drives labels + branch id). */
  importName: string;
  /** Drop worker units from the generated branch steps. */
  outputSkipWorkers: boolean;
}

function humanize(id: string): string {
  return id
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function sanitizeId(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "imported_build";
}

function uniqueBranchId(base: string, compact: CompactBuildFile): string {
  if (!compact[base]) {
    return base;
  }
  let suffix = 2;
  while (compact[`${base}_${suffix}`]) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

function toCompactSteps(steps: ImportedStep[], options: PlanMergeOptions): CompactBuildStep[] {
  return steps
    .filter((step) => !(options.outputSkipWorkers && step.isWorker))
    .map((step) => {
      const compactStep: CompactBuildStep = { action: actionForOutput(step.action, step.note) };
      if (step.time) {
        compactStep.time = step.time;
      }
      if (typeof step.supply === "number") {
        compactStep.supply = step.supply;
      }
      return compactStep;
    });
}

function matchSteps(steps: ImportedStep[], options: PlanMergeOptions): ImportedStep[] {
  return options.skipWorkers ? steps.filter((step) => !step.isWorker) : steps;
}

function importLabel(options: PlanMergeOptions): string {
  return `${options.importName} [imported]`;
}

function existingLabelFromTarget(targetId: string): string {
  return `${humanize(targetId)} [existing build]`;
}

function firstStepTime(steps: CompactBuildStep[]): string | undefined {
  for (const step of steps) {
    if (step.time) {
      return step.time;
    }
  }
  return undefined;
}

function actionStepCount(branch: CompactBranchEntry): number {
  if (!branch.steps) {
    return 0;
  }
  return branch.steps.filter((step) => !step.decision).length;
}

function trailingDecision(branch: CompactBranchEntry): CompactStepDecision | undefined {
  const last = branch.steps?.[branch.steps.length - 1];
  return last?.decision;
}

/**
 * Plan how to fold an imported build order into an existing compact build file,
 * branching only at the true point of divergence. Never mutates the input.
 */
export function planMerge(
  compact: CompactBuildFile,
  _graph: ResolvedBuildGraph,
  importedSteps: ImportedStep[],
  match: MergeMatch | null,
  options: PlanMergeOptions
): MergePlan {
  const patched: CompactBuildFile = structuredClone(compact);
  const warnings: string[] = [];
  const matchList = matchSteps(importedSteps, options);

  const baseId = sanitizeId(options.importName);
  const newBranchId = uniqueBranchId(baseId, patched);

  if (!match) {
    return planNewRootChild(patched, compact, importedSteps, newBranchId, options, warnings);
  }

  const tail = matchList.slice(match.matchedStepCount);
  const tailSteps = toCompactSteps(tail, options);

  const decisionBranchName = match.divergeNodeId.endsWith("__decision")
    ? match.divergeNodeId.replace(/__decision$/, "")
    : null;

  if (decisionBranchName && patched[decisionBranchName]) {
    return planAddDecisionOption(
      patched,
      compact,
      decisionBranchName,
      tailSteps,
      newBranchId,
      options,
      warnings
    );
  }

  const branchId = match.divergeNodeId;
  const branch = patched[branchId];
  if (!branch || !branch.steps) {
    // Fallback: cannot locate a mutable branch (e.g. cross-file). Attach at root.
    warnings.push(
      `Divergence node "${branchId}" is not an editable branch in this file; attaching near the root instead.`
    );
    return planNewRootChild(patched, compact, importedSteps, newBranchId, options, warnings);
  }

  const actions = actionStepCount(branch);

  if (match.divergeStepIndex >= actions) {
    const decision = trailingDecision(branch);
    if (decision) {
      return planAddDecisionOption(patched, compact, branchId, tailSteps, newBranchId, options, warnings);
    }
    // Leaf branch: the import simply continues past the end -> extend in place.
    if (tailSteps.length === 0) {
      warnings.push("Import is identical to an existing path; nothing to merge.");
      return finalize(patched, compact, "extend", branchId, importLabel(options), match, warnings);
    }
    branch.steps = [...(branch.steps ?? []), ...tailSteps];
    return finalize(patched, compact, "extend", branchId, importLabel(options), match, warnings);
  }

  return planSplitBranch(patched, compact, branchId, match, tailSteps, newBranchId, options, warnings);
}

function planSplitBranch(
  patched: CompactBuildFile,
  original: CompactBuildFile,
  branchId: string,
  match: MergeMatch,
  tailSteps: CompactBuildStep[],
  newBranchId: string,
  options: PlanMergeOptions,
  warnings: string[]
): MergePlan {
  const branch = patched[branchId];
  const steps = branch.steps ?? [];
  const shared = steps.slice(0, match.divergeStepIndex);
  const existingTail = steps.slice(match.divergeStepIndex);

  const continuationId = uniqueBranchId(`${branchId}_continue`, patched);
  patched[continuationId] = { steps: existingTail };

  patched[newBranchId] = { steps: tailSteps };

  const decisionTime = firstStepTime(tailSteps) ?? firstStepTime(existingTail);
  const decisionStep: CompactBuildStep = {
    decision: {
      "1": { label: existingLabelFromTarget(continuationId), target: continuationId },
      "2": { label: importLabel(options), target: newBranchId }
    }
  };
  if (decisionTime) {
    decisionStep.time = decisionTime;
  }

  branch.steps = [...shared, decisionStep];

  return finalize(patched, original, "split-branch", newBranchId, importLabel(options), match, warnings);
}

function planAddDecisionOption(
  patched: CompactBuildFile,
  original: CompactBuildFile,
  branchId: string,
  tailSteps: CompactBuildStep[],
  newBranchId: string,
  options: PlanMergeOptions,
  warnings: string[]
): MergePlan {
  const branch = patched[branchId];
  const decision = trailingDecision(branch);
  if (!decision) {
    warnings.push(`Expected a decision on branch "${branchId}" but found none; attaching at root.`);
    return planNewRootChild(patched, original, [], newBranchId, options, warnings);
  }

  patched[newBranchId] = { steps: tailSteps.length > 0 ? tailSteps : [{ action: humanize(newBranchId) }] };

  if (!decision["3"]) {
    decision["3"] = { label: importLabel(options), target: newBranchId };
    return finalize(patched, original, "add-decision-option", newBranchId, importLabel(options), null, warnings);
  }

  // No free slot: nest the import under the middle option via a new sub-decision.
  warnings.push(
    `Decision on "${branchId}" already has three options; nesting the import under a new sub-decision.`
  );
  const previousMiddle = decision["2"].target;
  const subDecisionId = uniqueBranchId(`${branchId}_more`, patched);
  patched[subDecisionId] = {
    steps: [
      {
        decision: {
          "1": { label: existingLabelFromTarget(previousMiddle), target: previousMiddle },
          "2": { label: importLabel(options), target: newBranchId }
        }
      }
    ]
  };
  decision["2"] = { label: `${decision["2"].label} / more`, target: subDecisionId };

  return finalize(patched, original, "add-decision-option", newBranchId, importLabel(options), null, warnings);
}

function planNewRootChild(
  patched: CompactBuildFile,
  original: CompactBuildFile,
  importedSteps: ImportedStep[],
  newBranchId: string,
  options: PlanMergeOptions,
  warnings: string[]
): MergePlan {
  const rootKey = options.race;
  const root = patched[rootKey];
  if (!root) {
    throw new Error(`Race root branch "${rootKey}" not found in the target build file.`);
  }

  const importCompactSteps = toCompactSteps(importedSteps, options);
  patched[newBranchId] = { steps: importCompactSteps };

  let existingTarget: string;
  if (typeof root.target === "string" && root.target.trim().length > 0) {
    existingTarget = root.target.trim();
  } else {
    // Root carries its own steps: move them into a dedicated branch first.
    const movedId = uniqueBranchId(`${rootKey}_original`, patched);
    patched[movedId] = { steps: root.steps ?? [] };
    existingTarget = movedId;
  }

  const decisionTime = firstStepTime(importCompactSteps) ?? "0:00";
  patched[rootKey] = {
    steps: [
      {
        time: decisionTime,
        decision: {
          "1": { label: existingLabelFromTarget(existingTarget), target: existingTarget },
          "2": { label: importLabel(options), target: newBranchId }
        }
      }
    ]
  };

  return finalize(patched, original, "new-root-child", newBranchId, importLabel(options), null, warnings);
}

function finalize(
  patched: CompactBuildFile,
  original: CompactBuildFile,
  action: MergePlan["action"],
  newBranchId: string,
  decisionLabel: string,
  match: MergeMatch | null,
  warnings: string[]
): MergePlan {
  return {
    match,
    action,
    newBranchId,
    decisionLabel,
    patchedCompact: patched,
    diff: computeMergeDiff(original, patched),
    warnings
  };
}
