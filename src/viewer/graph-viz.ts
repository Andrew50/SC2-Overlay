import type { BuildStep, DecisionNodeEntry, ResolvedBuildGraph } from "../core/types";

export interface StepNodeMeta {
  buildNodeId: string;
  stepIndex: number;
  step: BuildStep;
}

export interface GraphElementNode {
  group: "nodes";
  data: {
    id: string;
    label: string;
    kind: "step" | "branch" | "terminal";
  };
}

export interface GraphElementEdge {
  group: "edges";
  data: {
    id: string;
    source: string;
    target: string;
    label: string;
    edgeKind: "sequential" | "branch";
    minLen: number;
  };
}

export type GraphElement = GraphElementNode | GraphElementEdge;

export interface StepGraphView {
  elements: GraphElement[];
  stepMeta: Map<string, StepNodeMeta>;
}

function formatStepLine(step: BuildStep): string {
  const parts: string[] = [];
  if (step.time) {
    parts.push(step.time);
  }
  if (typeof step.supply === "number") {
    parts.push(String(step.supply));
  }
  const prefix = parts.length > 0 ? `${parts.join(" | ")} — ` : "";
  return `${prefix}${step.action}`;
}

function stepNodeId(buildNodeId: string, stepIndex: number): string {
  return `${buildNodeId}::${stepIndex}`;
}

function resolveBuildEntry(graph: ResolvedBuildGraph, buildNodeId: string): string {
  let currentId = buildNodeId;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(currentId)) {
      throw new Error(`Alias cycle detected at build node "${buildNodeId}"`);
    }
    visited.add(currentId);

    const node = graph.nodes[currentId];
    if (!node || node.type !== "build") {
      throw new Error(`Missing build node "${currentId}" while resolving "${buildNodeId}"`);
    }
    if (node.steps.length > 0) {
      return currentId;
    }
    if (!node.next) {
      throw new Error(`Build node "${currentId}" has no steps and no continuation`);
    }

    const nextNode = graph.nodes[node.next];
    if (nextNode?.type === "decision") {
      return currentId;
    }

    currentId = node.next;
  }
}

function getDecisionBranches(decisionNode: DecisionNodeEntry): Array<{ label: string; target: string }> {
  const branches = [decisionNode.left, decisionNode.middle];
  if (decisionNode.right) {
    branches.push(decisionNode.right);
  }
  return branches;
}

class StepGraphBuilder {
  private readonly graph: ResolvedBuildGraph;
  private readonly nodes = new Map<string, GraphElementNode>();
  private readonly edges: GraphElementEdge[] = [];
  private readonly stepMeta = new Map<string, StepNodeMeta>();
  private readonly expandedBuildNodes = new Set<string>();
  private readonly edgeKeys = new Set<string>();

  constructor(graph: ResolvedBuildGraph) {
    this.graph = graph;
  }

  private addEdge(source: string, target: string, branchLabel?: string): void {
    const edgeKind = branchLabel ? "branch" : "sequential";
    const key = branchLabel ? `${source}|${target}|${branchLabel}` : `${source}|${target}|seq`;
    if (this.edgeKeys.has(key)) {
      return;
    }
    this.edgeKeys.add(key);

    this.edges.push({
      group: "edges",
      data: {
        id: key,
        source,
        target,
        label: branchLabel ?? "",
        edgeKind,
        minLen: edgeKind === "sequential" ? 1 : 5
      }
    });
  }

  private ensureRootAnchor(buildNodeId: string, decisionNode: DecisionNodeEntry): string {
    const id = `${buildNodeId}::start`;
    if (!this.nodes.has(id)) {
      const timePart = decisionNode.time ? `${decisionNode.time} — ` : "";
      this.nodes.set(id, {
        group: "nodes",
        data: {
          id,
          label: `${timePart}Build start`,
          kind: "branch"
        }
      });
    }
    return id;
  }

  private ensureStepChain(buildNodeId: string): string[] {
    const resolvedId = resolveBuildEntry(this.graph, buildNodeId);
    const node = this.graph.nodes[resolvedId];
    if (!node || node.type !== "build") {
      throw new Error(`Expected build node at "${resolvedId}"`);
    }

    const stepIds: string[] = [];
    node.steps.forEach((step, index) => {
      const id = stepNodeId(resolvedId, index);
      stepIds.push(id);

      if (this.nodes.has(id)) {
        return;
      }

      this.stepMeta.set(id, {
        buildNodeId: resolvedId,
        stepIndex: index,
        step
      });
      this.nodes.set(id, {
        group: "nodes",
        data: {
          id,
          label: formatStepLine(step),
          kind: "step"
        }
      });
    });

    for (let index = 1; index < stepIds.length; index += 1) {
      this.addEdge(stepIds[index - 1]!, stepIds[index]!);
    }

    return stepIds;
  }

  private continueFromBuildNode(buildNodeId: string, tailStepId: string): void {
    const node = this.graph.nodes[buildNodeId];
    if (!node || node.type !== "build" || !node.next) {
      return;
    }

    const nextNode = this.graph.nodes[node.next];
    if (!nextNode) {
      throw new Error(`Build node "${buildNodeId}" references missing next node "${node.next}"`);
    }

    if (nextNode.type === "decision") {
      for (const branch of getDecisionBranches(nextNode)) {
        this.connectToBuildNode(branch.target, tailStepId, branch.label);
      }
      return;
    }

    this.connectToBuildNode(node.next, tailStepId);
  }

  private connectToBuildNode(buildNodeId: string, fromStepId: string | null, branchLabel?: string): void {
    let currentId = buildNodeId;
    const visited = new Set<string>();

    while (true) {
      if (visited.has(currentId)) {
        throw new Error(`Alias cycle detected at build node "${buildNodeId}"`);
      }
      visited.add(currentId);

      const node = this.graph.nodes[currentId];
      if (!node || node.type !== "build") {
        throw new Error(`Missing build node "${currentId}" while connecting "${buildNodeId}"`);
      }

      if (node.steps.length > 0) {
        const stepIds = this.ensureStepChain(currentId);
        const firstStepId = stepIds[0]!;
        const tailStepId = stepIds[stepIds.length - 1]!;

        if (fromStepId) {
          this.addEdge(fromStepId, firstStepId, branchLabel);
        }

        if (this.expandedBuildNodes.has(currentId)) {
          return;
        }
        this.expandedBuildNodes.add(currentId);
        this.continueFromBuildNode(currentId, tailStepId);
        return;
      }

      if (!node.next) {
        throw new Error(`Build node "${currentId}" has no steps and no continuation`);
      }

      const nextNode = this.graph.nodes[node.next];
      if (!nextNode) {
        throw new Error(`Missing next node "${node.next}" from build node "${currentId}"`);
      }

      if (nextNode.type === "decision") {
        // A decision at the very root (no preceding step) is valid — e.g. an
        // imported build branched in at the race root. Synthesize a start anchor
        // so the decision options have a node to fan out from.
        const anchorStepId = fromStepId ?? this.ensureRootAnchor(currentId, nextNode);

        const expansionKey = `${currentId}::decision`;
        if (this.expandedBuildNodes.has(expansionKey)) {
          return;
        }
        this.expandedBuildNodes.add(expansionKey);

        for (const branch of getDecisionBranches(nextNode)) {
          this.connectToBuildNode(branch.target, anchorStepId, branch.label);
        }
        return;
      }

      currentId = node.next;
    }
  }

  build(): StepGraphView {
    this.connectToBuildNode(this.graph.rootNodeId, null);

    const outgoingBranchCounts = new Map<string, number>();
    const outgoingCounts = new Map<string, number>();

    for (const edge of this.edges) {
      outgoingCounts.set(edge.data.source, (outgoingCounts.get(edge.data.source) ?? 0) + 1);
      if (edge.data.edgeKind === "branch") {
        outgoingBranchCounts.set(edge.data.source, (outgoingBranchCounts.get(edge.data.source) ?? 0) + 1);
      }
    }

    for (const node of this.nodes.values()) {
      const outgoing = outgoingCounts.get(node.data.id) ?? 0;
      const branchOutgoing = outgoingBranchCounts.get(node.data.id) ?? 0;

      if (outgoing === 0) {
        node.data.kind = "terminal";
      } else if (branchOutgoing > 1 || (branchOutgoing === 1 && outgoing > 1)) {
        node.data.kind = "branch";
      } else {
        node.data.kind = "step";
      }
    }

    return {
      elements: [...this.nodes.values(), ...this.edges],
      stepMeta: this.stepMeta
    };
  }
}

export function buildStepGraph(graph: ResolvedBuildGraph): StepGraphView {
  return new StepGraphBuilder(graph).build();
}

export function graphToElements(graph: ResolvedBuildGraph): GraphElement[] {
  return buildStepGraph(graph).elements;
}

export function getTerminalStepId(graph: ResolvedBuildGraph, buildNodeId: string): string | null {
  try {
    let currentId = buildNodeId;
    const visited = new Set<string>();

    while (true) {
      if (visited.has(currentId)) {
        return null;
      }
      visited.add(currentId);

      const node = graph.nodes[currentId];
      if (!node || node.type !== "build") {
        return null;
      }

      if (node.steps.length > 0) {
        return stepNodeId(currentId, node.steps.length - 1);
      }

      if (!node.next) {
        return null;
      }

      const nextNode = graph.nodes[node.next];
      if (nextNode?.type === "decision" || !nextNode) {
        return null;
      }

      currentId = node.next;
    }
  } catch {
    return null;
  }
}

function buildAdjacency(elements: GraphElement[]): {
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
} {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();

  for (const element of elements) {
    if (element.group !== "edges") {
      continue;
    }

    const { source, target } = element.data;
    const next = outgoing.get(source) ?? [];
    next.push(target);
    outgoing.set(source, next);

    const prev = incoming.get(target) ?? [];
    prev.push(source);
    incoming.set(target, prev);
  }

  return { outgoing, incoming };
}

export function collectDescendants(stepGraph: StepGraphView, startStepId: string): Set<string> {
  const { outgoing } = buildAdjacency(stepGraph.elements);
  const visited = new Set<string>();
  const queue = [startStepId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const target of outgoing.get(current) ?? []) {
      queue.push(target);
    }
  }

  return visited;
}

export function collectAncestors(stepGraph: StepGraphView, startStepId: string): Set<string> {
  const { incoming } = buildAdjacency(stepGraph.elements);
  const visited = new Set<string>();
  const queue = [startStepId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const source of incoming.get(current) ?? []) {
      queue.push(source);
    }
  }

  return visited;
}
