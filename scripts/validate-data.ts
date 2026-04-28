import { loadInitialData } from "../src/core/loader";

try {
  const { config, raceOptions } = loadInitialData();
  const nodeCount = raceOptions.reduce((total, option) => total + Object.keys(option.graph.nodes).length, 0);
  console.log("Validation successful.");
  console.log(`Race options: ${raceOptions.map((option) => `${option.race}:${option.graph.id}`).join(", ")}`);
  console.log(`Resolved node count (all options): ${nodeCount}`);
  console.log(`Global hotkeys enabled: ${config.hotkeys.globalEnabled}`);
} catch (error) {
  console.error("Validation failed.");
  console.error(error);
  process.exit(1);
}
