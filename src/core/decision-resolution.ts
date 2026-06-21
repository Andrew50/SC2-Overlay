import type {
  DecisionBranch,
  DecisionBranchKey,
  DecisionNodeEntry,
  PlayerRace,
  PlayerRaceOption,
  ResolvedBuildGraph
} from "./types";

/**
 * Forced decision choices keyed by decision node id. Used by practice mode to
 * pin a single branch slot at every decision so only that line survives. Live
 * mode passes no forced choices and relies purely on persisted `disabled` flags.
 */
export type ForcedChoices = Record<string, DecisionBranchKey>;

export interface AvailableOption {
  slot: DecisionBranchKey;
  branch: DecisionBranch;
}

export interface DecisionResolution {
  /** True when the user should be shown a choice (>= 2 live options). */
  presented: boolean;
  options: AvailableOption[];
  /** Set when the decision collapses to a single option that should auto-resolve. */
  autoResolved?: AvailableOption;
}

function decisionOptions(node: DecisionNodeEntry): AvailableOption[] {
  const options: AvailableOption[] = [
    { slot: "left", branch: node.left },
    { slot: "middle", branch: node.middle }
  ];
  if (node.right) {
    options.push({ slot: "right", branch: node.right });
  }
  return options;
}

/**
 * A node "has an active leaf" if at least one reachable build leaf is not
 * disabled, after honoring forced choices. Disabling a branch therefore prunes
 * its entire subtree, and a decision whose every option leads only to disabled
 * leaves is itself treated as having no active leaf.
 */
export function hasActiveLeaf(
  graph: ResolvedBuildGraph,
  nodeId: string,
  forced?: ForcedChoices,
  cache: Map<string, boolean> = new Map(),
  visiting: Set<string> = new Set()
): boolean {
  const cached = cache.get(nodeId);
  if (cached !== undefined) {
    return cached;
  }
  if (visiting.has(nodeId)) {
    return false;
  }

  const node = graph.nodes[nodeId];
  if (!node) {
    return false;
  }

  visiting.add(nodeId);
  let result = false;

  if (node.type === "build") {
    if (node.disabled) {
      result = false;
    } else if (!node.next) {
      result = true;
    } else {
      result = hasActiveLeaf(graph, node.next, forced, cache, visiting);
    }
  } else {
    const forcedSlot = forced?.[nodeId];
    const candidates = decisionOptions(node).filter((option) => !forcedSlot || option.slot === forcedSlot);
    result = candidates.some((option) => hasActiveLeaf(graph, option.branch.target, forced, cache, visiting));
  }

  visiting.delete(nodeId);
  cache.set(nodeId, result);
  return result;
}

/** Options at a decision whose target subtree still contains an active leaf. */
export function getAvailableOptions(
  graph: ResolvedBuildGraph,
  decisionNodeId: string,
  forced?: ForcedChoices
): AvailableOption[] {
  const node = graph.nodes[decisionNodeId];
  if (!node || node.type !== "decision") {
    return [];
  }

  const cache = new Map<string, boolean>();
  const forcedSlot = forced?.[decisionNodeId];
  return decisionOptions(node)
    .filter((option) => !forcedSlot || option.slot === forcedSlot)
    .filter((option) => hasActiveLeaf(graph, option.branch.target, forced, cache));
}

/**
 * Resolve a decision into either a presented choice (>= 2 live options) or an
 * implicit auto-resolution (<= 1 live option). This single rule subsumes both
 * "all-but-one branch disabled" collapsing and practice-mode locking.
 */
export function resolveDecision(
  graph: ResolvedBuildGraph,
  decisionNodeId: string,
  forced?: ForcedChoices
): DecisionResolution {
  const options = getAvailableOptions(graph, decisionNodeId, forced);
  if (options.length <= 1) {
    return { presented: false, options, autoResolved: options[0] };
  }
  return { presented: true, options };
}

/** Races whose root build graph still contains at least one active leaf. */
export function getAvailableRaces(
  raceOptions: PlayerRaceOption[],
  forcedRace?: PlayerRace
): PlayerRaceOption[] {
  return raceOptions.filter((option) => {
    if (forcedRace && option.playerRace !== forcedRace) {
      return false;
    }
    return hasActiveLeaf(option.graph, option.graph.rootNodeId);
  });
}
