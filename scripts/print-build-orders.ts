import { loadInitialData } from "../src/core/loader";
import type { BuildNode, BuildStep, PlayerRaceOption, ResolvedBuildGraph } from "../src/core/types";

interface DecisionChoice {
  nodeId: string;
  question: string;
  label: string;
  target: string;
}

interface BuildOrderPath {
  nodePath: string[];
  steps: BuildStep[];
  choices: DecisionChoice[];
}

function formatStep(step: BuildStep): string {
  const segments: string[] = [];
  if (step.time) {
    segments.push(step.time);
  }
  if (typeof step.supply === "number") {
    segments.push(`${step.supply}`);
  }
  const prefix = segments.length > 0 ? `${segments.join(" | ")} | ` : "";
  return `${prefix}${step.action}`;
}

function buildChoiceLabel(choice: DecisionChoice): string {
  return `${choice.question} -> ${choice.label} (${choice.target})`;
}

function collectBuildOrders(graph: ResolvedBuildGraph): BuildOrderPath[] {
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

function printRaceBuildOrders(option: PlayerRaceOption): void {
  const traversals = collectBuildOrders(option.graph);
  console.log(`\n=== ${option.label} (${option.buildId}) ===`);
  console.log(`Root node: ${option.graph.rootNodeId}`);
  console.log(`Total build orders: ${traversals.length}`);

  traversals.forEach((traversal, index) => {
    console.log(`\n[${index + 1}] Node path: ${traversal.nodePath.join(" -> ")}`);
    if (traversal.choices.length > 0) {
      console.log("  Decisions:");
      traversal.choices.forEach((choice, choiceIndex) => {
        console.log(`    ${choiceIndex + 1}. ${buildChoiceLabel(choice)}`);
      });
    }
    if (traversal.steps.length > 0) {
      console.log("  Steps:");
      traversal.steps.forEach((step, stepIndex) => {
        console.log(`    ${stepIndex + 1}. ${formatStep(step)}`);
      });
    } else {
      console.log("  Steps: (none)");
    }
  });
}

try {
  const { raceOptions } = loadInitialData();
  console.log("Resolved build-order traversals:");
  raceOptions.forEach((option) => {
    printRaceBuildOrders(option);
  });
} catch (error) {
  console.error("Failed to print build orders.");
  console.error(error);
  process.exit(1);
}
