import { loadInitialData } from "../src/core/loader";
import { collectBuildOrders, type DecisionChoice } from "../src/core/graph-traversal";
import type { BuildStep, PlayerRaceOption } from "../src/core/types";

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
