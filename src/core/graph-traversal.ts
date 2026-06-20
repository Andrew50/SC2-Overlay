import type { BuildNode, BuildStep, ResolvedBuildGraph } from "./types";

export interface DecisionChoice {
  nodeId: string;
  question: string;
  label: string;
  target: string;
}

export interface BuildOrderPath {
  nodePath: string[];
  steps: BuildStep[];
  choices: DecisionChoice[];
}

export function collectBuildOrders(graph: ResolvedBuildGraph): BuildOrderPath[] {
  const paths: BuildOrderPath[] = [];

  const walk = (
    nodeId: string,
    nodePath: string[],
    steps: BuildStep[],
    choices: DecisionChoice[],
    inPath: Set<string>
  ): void => {
    if (inPath.has(nodeId)) {
      throw new Error(`Traversal cycle detected at node "${nodeId}" in graph "${graph.id}"`);
    }

    const node = graph.nodes[nodeId];
    if (!node) {
      throw new Error(`Missing node "${nodeId}" in graph "${graph.id}"`);
    }

    const nextNodePath = [...nodePath, nodeId];
    const nextInPath = new Set(inPath);
    nextInPath.add(nodeId);

    if (node.type === "build") {
      const nextSteps = [...steps, ...node.steps];
      if (!node.next) {
        paths.push({
          nodePath: nextNodePath,
          steps: nextSteps,
          choices
        });
        return;
      }
      walk(node.next, nextNodePath, nextSteps, choices, nextInPath);
      return;
    }

    const decisionBranches: Array<{ label: string; target: string }> = [node.left, node.middle];
    if (node.right) {
      decisionBranches.push(node.right);
    }

    for (const branch of decisionBranches) {
      const choice: DecisionChoice = {
        nodeId,
        question: node.question,
        label: branch.label,
        target: branch.target
      };
      walk(branch.target, nextNodePath, steps, [...choices, choice], nextInPath);
    }
  };

  walk(graph.rootNodeId, [], [], [], new Set<string>());
  return paths;
}

export function isLeafNode(nodeId: string, node: BuildNode): boolean {
  return node.type === "build" && !node.next;
}

export function isAliasNode(node: BuildNode): boolean {
  return node.type === "build" && node.steps.length === 0 && Boolean(node.next);
}

export function classifyNodeKind(nodeId: string, node: BuildNode): string {
  if (isAliasNode(node)) {
    return "alias";
  }
  if (isLeafNode(nodeId, node)) {
    if (nodeId.includes("one_base")) {
      return "onebase";
    }
    if (nodeId.includes("proxy")) {
      return "proxy";
    }
    if (nodeId.includes("cc_first")) {
      return "ccfirst";
    }
    return "leaf";
  }
  if (nodeId.includes("proxy")) {
    return "proxy";
  }
  if (nodeId.includes("one_base")) {
    return "onebase";
  }
  if (nodeId.includes("cc_first")) {
    return "ccfirst";
  }
  return "core";
}
