import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema } from "ajv";
import type {
  AppConfig,
  BuildFile,
  BuildImport,
  BuildNode,
  BuildNodeEntry,
  BuildStep,
  CompactBuildFile,
  CompactBuildStep,
  DecisionBranch,
  DecisionNodeEntry,
  PlayerRace,
  OpponentRace,
  PlayerRaceOption,
  ResolvedBuildGraph
} from "./types";
import { loadSchemas } from "./schemas";

const ajv = new Ajv2020({ allErrors: true });
const RACE_ORDER: PlayerRace[] = ["zerg", "terran", "protoss"];
let validateConfigFn: ReturnType<typeof ajv.compile<AppConfig>> | null = null;
let validateBuildFn: ReturnType<typeof ajv.compile<CompactBuildFile>> | null = null;

interface BuildSource {
  id: string;
  filePath: string;
  build: CompactBuildFile;
}

interface RaceRootDefinition {
  buildId: string;
  branchId: string;
  playerRace: PlayerRace;
}

function resolveRootDir(): string {
  const envRoot = process.env.SC2_OVERLAY_APP_ROOT?.trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }
  return process.cwd();
}

function ensureValidators(): void {
  if (validateConfigFn && validateBuildFn) {
    return;
  }
  const { configSchema, buildSchema } = loadSchemas();
  validateConfigFn = ajv.compile<AppConfig>(configSchema as AnySchema);
  validateBuildFn = ajv.compile<CompactBuildFile>(buildSchema as AnySchema);
}

function readJson<T>(relativePath: string): T {
  const fullPath = path.resolve(resolveRootDir(), relativePath);
  const content = readFileSync(fullPath, "utf8");
  return JSON.parse(content) as T;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function ensureValidConfig(config: unknown): AppConfig {
  ensureValidators();
  const validator = validateConfigFn;
  if (!validator) {
    throw new Error("Config validator was not initialized.");
  }
  if (!validator(config)) {
    throw new Error(`Invalid config.json: ${ajv.errorsText(validator.errors)}`);
  }
  return config as AppConfig;
}

function ensureValidBuild(build: unknown, buildIdForError: string): CompactBuildFile {
  ensureValidators();
  const validator = validateBuildFn;
  if (!validator) {
    throw new Error("Build validator was not initialized.");
  }
  if (!validator(build)) {
    throw new Error(
      `Invalid build file (${buildIdForError}): ${ajv.errorsText(validator.errors)}`
    );
  }
  return build as CompactBuildFile;
}

function sanitizePrefixPart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "import";
}

function toDisplayName(value: string): string {
  return value
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function toTitleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

function collectJsonFiles(dirPath: string): string[] {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".json")) {
      continue;
    }
    if (entry.name === "index.json") {
      continue;
    }
    if (entry.name.startsWith("_")) {
      continue;
    }
    files.push(fullPath);
  }
  return files.sort();
}

function buildIdFromFilePath(buildsRootPath: string, filePath: string): string {
  const relativePath = path.relative(buildsRootPath, filePath);
  const withoutExt = relativePath.replace(/\.json$/i, "");
  const normalized = withoutExt.split(path.sep).join(".");
  if (!normalized) {
    throw new Error(`Unable to derive build id from file: ${filePath}`);
  }
  return normalized;
}

function loadBuildSources(buildsPathFromConfig: string): Map<string, BuildSource> {
  const buildsRootPath = path.resolve(resolveRootDir(), buildsPathFromConfig);
  const jsonFiles = collectJsonFiles(buildsRootPath);
  if (jsonFiles.length === 0) {
    throw new Error(`No build JSON files found under: ${buildsPathFromConfig}`);
  }

  const sources = new Map<string, BuildSource>();
  for (const filePath of jsonFiles) {
    const buildId = buildIdFromFilePath(buildsRootPath, filePath);
    if (sources.has(buildId)) {
      throw new Error(`Duplicate auto-derived build id "${buildId}" from file: ${filePath}`);
    }
    const rawBuild = readJsonFile<unknown>(filePath);
    const validatedBuild = ensureValidBuild(rawBuild, buildId);
    sources.set(buildId, {
      id: buildId,
      filePath,
      build: validatedBuild
    });
  }
  return sources;
}

function discoverRaceRoots(sources: Map<string, BuildSource>): Map<PlayerRace, RaceRootDefinition> {
  const roots = new Map<PlayerRace, RaceRootDefinition>();

  for (const source of sources.values()) {
    for (const playerRace of RACE_ORDER) {
      const branchId = playerRace;
      if (!Object.prototype.hasOwnProperty.call(source.build, branchId)) {
        continue;
      }
      const existing = roots.get(playerRace);
      if (existing) {
        throw new Error(
          `Player root "${branchId}" is defined multiple times (${existing.buildId} and ${source.id}). ` +
            "Only one root branch per player race is allowed."
        );
      }
      roots.set(playerRace, { buildId: source.id, branchId, playerRace });
    }
  }

  for (const playerRace of RACE_ORDER) {
    if (!roots.has(playerRace)) {
      throw new Error(`Missing required player root branch "${playerRace}" across all build files.`);
    }
  }

  return roots;
}

function pickCompactRootBranch(compactBuild: CompactBuildFile, buildId: string, requestedRace: OpponentRace): string {
  if (Object.prototype.hasOwnProperty.call(compactBuild, requestedRace)) {
    return requestedRace;
  }

  const branchNames = Object.keys(compactBuild).sort();
  if (branchNames.length >= 1) {
    return branchNames[0];
  }

  throw new Error(`Build "${buildId}" has no branches.`);
}

function toDecisionBranch(
  rawBranch: { label: string; target: string },
  resolveTarget: (target: string) => string
): DecisionBranch {
  return {
    label: rawBranch.label,
    target: resolveTarget(rawBranch.target)
  };
}

function normalizeCompactBuild(
  compactBuild: CompactBuildFile,
  buildId: string,
  requestedRace: OpponentRace
): BuildFile {
  const nodes: Record<string, BuildNode> = {};
  const imports: BuildImport[] = [];
  const importKeyToPrefix = new Map<string, string>();
  const usedPrefixes = new Set<string>();

  const getImportPrefix = (targetBuildId: string, fromNodeId: string): string => {
    const key = `${targetBuildId}:${fromNodeId}`;
    const existing = importKeyToPrefix.get(key);
    if (existing) {
      return existing;
    }

    const basePrefix = `${sanitizePrefixPart(targetBuildId)}_${sanitizePrefixPart(fromNodeId)}`;
    let prefix = basePrefix;
    let suffix = 2;
    while (usedPrefixes.has(prefix)) {
      prefix = `${basePrefix}_${suffix}`;
      suffix += 1;
    }
    usedPrefixes.add(prefix);
    importKeyToPrefix.set(key, prefix);
    imports.push({
      buildId: targetBuildId,
      fromNodeId,
      asPrefix: prefix
    });
    return prefix;
  };

  const resolveTarget = (target: string): string => {
    const separator = target.indexOf(":");
    if (separator < 0) {
      return target;
    }
    const targetBuildId = target.slice(0, separator).trim();
    const branchId = target.slice(separator + 1).trim();
    if (!targetBuildId || !branchId) {
      throw new Error(`Invalid compact target reference "${target}" in ${buildId}`);
    }
    const prefix = getImportPrefix(targetBuildId, branchId);
    return `${prefix}__${branchId}`;
  };

  for (const [branchName, branchEntry] of Object.entries(compactBuild)) {
    const directTarget = typeof branchEntry.target === "string" ? branchEntry.target.trim() : "";
    if (directTarget.length > 0) {
      if (nodes[branchName]) {
        throw new Error(`Compact branch id collision in ${buildId}: ${branchName}`);
      }
      nodes[branchName] = {
        type: "build",
        title: toDisplayName(branchName),
        steps: [],
        next: resolveTarget(directTarget)
      } satisfies BuildNodeEntry;
      continue;
    }

    const steps = branchEntry.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(
        `Compact branch "${branchName}" in ${buildId} must contain at least one step or a branch-level target`
      );
    }

    const buildSteps: BuildStep[] = [];
    let nextDecisionId: string | undefined;

    steps.forEach((step: CompactBuildStep, index: number) => {
      const hasAction = typeof step.action === "string" && step.action.trim().length > 0;
      const hasDecision = Boolean(step.decision);

      if (!hasAction && !hasDecision) {
        throw new Error(`Compact step ${index + 1} in branch "${branchName}" (${buildId}) needs action and/or decision`);
      }

      if (hasAction) {
        buildSteps.push({
          time: step.time,
          supply: step.supply,
          action: step.action!.trim(),
          exact: step.exact
        });
      }

      if (!step.decision) {
        return;
      }

      if (nextDecisionId) {
        throw new Error(`Compact branch "${branchName}" in ${buildId} can only contain one decision step`);
      }
      if (index < steps.length - 1) {
        throw new Error(`Compact branch "${branchName}" in ${buildId} must end at the decision step`);
      }
      nextDecisionId = `${branchName}__decision`;
      if (nodes[nextDecisionId]) {
        throw new Error(`Generated decision node collision: ${nextDecisionId}`);
      }

      nodes[nextDecisionId] = {
        type: "decision",
        title: `${toDisplayName(branchName)} Decision`,
        kind: "soft",
        question: `Choose ${toDisplayName(branchName)} follow-up`,
        defaultBranch: "left",
        time: step.time,
        supply: step.supply,
        left: toDecisionBranch(step.decision["1"], resolveTarget),
        middle: toDecisionBranch(step.decision["2"], resolveTarget),
        right: step.decision["3"] ? toDecisionBranch(step.decision["3"], resolveTarget) : undefined
      } satisfies DecisionNodeEntry;
    });

    if (nodes[branchName]) {
      throw new Error(`Compact branch id collision in ${buildId}: ${branchName}`);
    }

    nodes[branchName] = {
      type: "build",
      title: toDisplayName(branchName),
      steps: buildSteps,
      next: nextDecisionId
    } satisfies BuildNodeEntry;
  }

  return {
    id: buildId,
    name: toDisplayName(buildId),
    race: requestedRace,
    metadata: {},
    imports: imports.length > 0 ? imports : undefined,
    rootNodeId: pickCompactRootBranch(compactBuild, buildId, requestedRace),
    nodes
  };
}

function remapNode(node: BuildNode, remapId: (value: string) => string): BuildNode {
  if (node.type === "build") {
    return {
      ...node,
      next: node.next ? remapId(node.next) : undefined
    };
  }

  const decisionNode: DecisionNodeEntry = {
    ...node,
    left: {
      ...node.left,
      target: remapId(node.left.target)
    },
    middle: {
      ...node.middle,
      target: remapId(node.middle.target)
    },
    right: node.right
      ? {
          ...node.right,
          target: remapId(node.right.target)
        }
      : undefined
  };
  return decisionNode;
}

function collectReachableNodes(nodes: Record<string, BuildNode>, fromNodeId: string): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [fromNodeId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }

    const node = nodes[current];
    if (!node) {
      throw new Error(`Referenced import start node does not exist: ${fromNodeId}`);
    }

    visited.add(current);
    if (node.type === "build" && node.next) {
      queue.push(node.next);
    }
    if (node.type === "decision") {
      queue.push(node.left.target, node.middle.target);
      if (node.right) {
        queue.push(node.right.target);
      }
    }
  }

  return visited;
}

function validateGraphReferences(graph: ResolvedBuildGraph): void {
  const nodeIds = new Set(Object.keys(graph.nodes));
  if (!nodeIds.has(graph.rootNodeId)) {
    throw new Error(`rootNodeId not found in resolved graph: ${graph.rootNodeId}`);
  }

  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.type === "build") {
      if (node.next && !nodeIds.has(node.next)) {
        throw new Error(`Node ${id} references missing next node: ${node.next}`);
      }
      continue;
    }

    if (!nodeIds.has(node.left.target)) {
      throw new Error(`Decision ${id} left target is missing: ${node.left.target}`);
    }
    if (!nodeIds.has(node.middle.target)) {
      throw new Error(`Decision ${id} middle target is missing: ${node.middle.target}`);
    }
    if (node.right && !nodeIds.has(node.right.target)) {
      throw new Error(`Decision ${id} right target is missing: ${node.right.target}`);
    }
    if (node.defaultBranch !== "left") {
      throw new Error(`Decision ${id} defaultBranch must be left`);
    }
  }
}

function resolveBuildById(
  buildId: string,
  sources: Map<string, BuildSource>,
  requestedRace: OpponentRace,
  stack: string[] = []
): ResolvedBuildGraph {
  if (stack.includes(buildId)) {
    throw new Error(`Reference cycle detected while resolving build: ${[...stack, buildId].join(" -> ")}`);
  }

  const source = sources.get(buildId);
  if (!source) {
    throw new Error(`Unknown buildId referenced: ${buildId}`);
  }

  const buildFile = normalizeCompactBuild(source.build, buildId, requestedRace);
  const nextStack = [...stack, buildId];

  let mergedNodes: Record<string, BuildNode> = {};
  const rootNodeId = buildFile.rootNodeId;

  for (const importRef of buildFile.imports ?? []) {
    const importedGraph = resolveBuildById(importRef.buildId, sources, requestedRace, nextStack);
    const importNodeIds = importRef.fromNodeId
      ? collectReachableNodes(importedGraph.nodes, importRef.fromNodeId)
      : new Set(Object.keys(importedGraph.nodes));
    const prefix = importRef.asPrefix?.trim() ? `${importRef.asPrefix.trim()}__` : "";
    const remapId = (value: string): string => `${prefix}${value}`;

    for (const oldId of importNodeIds) {
      const oldNode = importedGraph.nodes[oldId];
      const newId = remapId(oldId);
      if (!oldNode) {
        continue;
      }
      if (mergedNodes[newId]) {
        throw new Error(`Import collision at node id: ${newId}`);
      }
      mergedNodes[newId] = remapNode(oldNode, remapId);
    }
  }

  mergedNodes = { ...mergedNodes, ...buildFile.nodes };
  const resolvedGraph: ResolvedBuildGraph = {
    id: buildFile.id,
    name: buildFile.name,
    race: requestedRace,
    metadata: buildFile.metadata,
    rootNodeId,
    nodes: mergedNodes
  };

  validateGraphReferences(resolvedGraph);
  return resolvedGraph;
}

export function loadConfig(): AppConfig {
  return ensureValidConfig(readJson<AppConfig>("config.json"));
}

export function loadResolvedGraph(config: AppConfig): ResolvedBuildGraph {
  const raceOptions = loadPlayerRaceOptions(config);
  if (raceOptions.length === 0) {
    throw new Error("No player race options were resolved.");
  }
  return raceOptions[0].graph;
}

function getPrimaryRootForPlayerRace(
  raceRoots: Map<PlayerRace, RaceRootDefinition>,
  playerRace: PlayerRace
): RaceRootDefinition {
  const root = raceRoots.get(playerRace);
  if (root) {
    return root;
  }
  throw new Error(`Missing required player root for player race "${playerRace}".`);
}

export function loadPlayerRaceOptions(config: AppConfig): PlayerRaceOption[] {
  const sources = loadBuildSources(config.data.buildsPath);
  const raceRoots = discoverRaceRoots(sources);

  return RACE_ORDER.map((playerRace) => {
    const root = getPrimaryRootForPlayerRace(raceRoots, playerRace);
    const graph = resolveBuildById(root.buildId, sources, playerRace);
    graph.rootNodeId = root.branchId;
    return {
      playerRace,
      buildId: root.buildId,
      label: toTitleCase(playerRace),
      graph
    } satisfies PlayerRaceOption;
  });
}

export function loadInitialData() {
  const config = loadConfig();
  const raceOptions = loadPlayerRaceOptions(config);
  return { config, raceOptions };
}
