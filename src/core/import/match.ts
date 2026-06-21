import type { BuildStep, ResolvedBuildGraph } from "../types";
import { collectBuildOrders, type BuildOrderPath } from "../graph-traversal";
import { normalizeAction } from "./normalize";
import { parseTimeToSeconds } from "./util";
import type { ImportedStep, MatchOptions, MergeMatch } from "./types";

/**
 * Map a matched-prefix length back to the divergence position. Walks build and
 * decision nodes in order so that landing exactly on a decision boundary is
 * reported as that decision node (enabling add-decision-option), rather than as
 * step 0 of a child branch.
 */
function divergencePosition(
  graph: ResolvedBuildGraph,
  nodePath: string[],
  matchedCount: number
): { nodeId: string; stepIndex: number } {
  let cursor = 0;
  let lastBuildNodeId = "";
  let lastBuildNodeLength = 0;

  for (const nodeId of nodePath) {
    const node = graph.nodes[nodeId];
    if (!node) {
      continue;
    }
    if (node.type === "build") {
      if (matchedCount < cursor + node.steps.length) {
        return { nodeId, stepIndex: matchedCount - cursor };
      }
      cursor += node.steps.length;
      lastBuildNodeId = nodeId;
      lastBuildNodeLength = node.steps.length;
      continue;
    }
    // Decision node: divergence lands here only if every step so far matched.
    if (matchedCount === cursor) {
      return { nodeId, stepIndex: 0 };
    }
  }

  return { nodeId: lastBuildNodeId, stepIndex: lastBuildNodeLength };
}

function importStepsForMatching(steps: ImportedStep[], opts: MatchOptions): ImportedStep[] {
  if (!opts.skipWorkers) {
    return steps;
  }
  return steps.filter((step) => !step.isWorker);
}

function stepsMatch(imported: ImportedStep, existing: BuildStep, opts: MatchOptions): boolean {
  const existingNorm = normalizeAction(existing.action);
  if (imported.matchKey !== existingNorm.matchKey) {
    return false;
  }

  const existingSeconds = parseTimeToSeconds(existing.time);
  if (imported.timeSeconds !== undefined && existingSeconds !== undefined) {
    // Timing is the authoritative ordering signal. Supply is a noisy proxy: it
    // shifts with how many workers happened to pop before a step, so two builds
    // can hit the *same* action at the *same* time with different supply counts.
    // When the action and timing already agree, that is the same step — supply
    // differences must not force a spurious branch.
    return Math.abs(imported.timeSeconds - existingSeconds) <= opts.timeToleranceSec;
  }

  // No reliable timestamp on at least one side. Fall back to supply (the only
  // remaining progress signal) when both sides provide it.
  if (imported.supply !== undefined && existing.supply !== undefined) {
    return Math.abs(imported.supply - existing.supply) <= opts.supplyTolerance;
  }

  // Only the action is comparable; treat equal actions as a match.
  return true;
}

/**
 * Find the existing build path that shares the longest prefix with the import.
 * Returns null when nothing matches (score 0 at the very first comparable step).
 */
export function findMergePoint(
  graph: ResolvedBuildGraph,
  importedSteps: ImportedStep[],
  opts: MatchOptions
): MergeMatch | null {
  const paths = collectBuildOrders(graph);
  const matchSteps = importStepsForMatching(importedSteps, opts);

  let best: MergeMatch | null = null;
  let bestScore = -1;

  for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
    const path: BuildOrderPath = paths[pathIndex];
    let matched = 0;
    while (matched < matchSteps.length && matched < path.steps.length) {
      if (!stepsMatch(matchSteps[matched], path.steps[matched], opts)) {
        break;
      }
      matched += 1;
    }

    const { nodeId, stepIndex } = divergencePosition(graph, path.nodePath, matched);

    if (matched > bestScore) {
      bestScore = matched;
      best = {
        pathIndex,
        nodePath: path.nodePath,
        matchedStepCount: matched,
        divergeNodeId: nodeId,
        divergeStepIndex: stepIndex,
        score: matched
      };
    }
  }

  if (!best || bestScore === 0) {
    return null;
  }
  return best;
}
