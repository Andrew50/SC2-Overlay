import type { BuildOrderPath } from "./graph-traversal";
import type { DecisionBranchKey, DecisionNodeEntry, PlayerRaceOption, PracticeSessionConfig } from "./types";

export type { PracticeSessionConfig };

function branchKeyForTarget(node: DecisionNodeEntry, target: string): DecisionBranchKey | undefined {
  if (node.left.target === target) {
    return "left";
  }
  if (node.middle.target === target) {
    return "middle";
  }
  if (node.right?.target === target) {
    return "right";
  }
  return undefined;
}

function pathBranchLabel(path: BuildOrderPath): string {
  const lastChoice = path.choices[path.choices.length - 1];
  if (lastChoice) {
    return lastChoice.label;
  }
  const leafId = path.nodePath[path.nodePath.length - 1];
  return leafId ?? "Build order";
}

export function practiceConfigFromPath(
  option: PlayerRaceOption,
  path: BuildOrderPath
): PracticeSessionConfig {
  const rememberedChoices: Record<string, DecisionBranchKey> = {};

  for (const choice of path.choices) {
    const node = option.graph.nodes[choice.nodeId];
    if (!node || node.type !== "decision") {
      continue;
    }
    const branchKey = branchKeyForTarget(node, choice.target);
    if (branchKey) {
      rememberedChoices[choice.nodeId] = branchKey;
    }
  }

  return {
    playerRace: option.playerRace,
    rememberedChoices,
    branchLabel: pathBranchLabel(path)
  };
}
