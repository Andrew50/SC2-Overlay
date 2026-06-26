import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { AppConfig, BuildStep, InitialAppData, PlayerRaceOption, ResolvedBuildGraph } from "../core/types";
import type {
  ImportPreviewRequest as ImportRequest,
  ImportPreviewResponse as ImportResponse
} from "../core/import/types";
import { collectBuildOrders, type BuildOrderPath } from "../core/graph-traversal";
import { practiceConfigFromPath } from "../core/practice-session";
import { hasActiveLeaf } from "../core/decision-resolution";
import type { SetBranchDisabledRequest, SetBranchDisabledResponse } from "../core/branch-state/types";
import type { UpdateDecisionLabelRequest, UpdateDecisionLabelResponse } from "../core/update-decision-label/types";
import {
  buildStepGraph,
  collectAncestors,
  collectDescendants,
  type DecisionLabelRef,
  type StepGraphView
} from "./graph-viz";

cytoscape.use(dagre);

const raceTabsEl = document.querySelector<HTMLElement>("#race-tabs");
const layoutEl = document.querySelector<HTMLElement>(".layout");
const sidebarResizerEl = document.getElementById("sidebar-resizer");
const pathSelectorEl = document.querySelector<HTMLElement>("#path-selector");
const buildOrderEl = document.querySelector<HTMLElement>("#build-order");
const branchControlEl = document.querySelector<HTMLElement>("#branch-control");
const branchControlNameEl = document.querySelector<HTMLElement>("#branch-control-name");
const branchControlStatusEl = document.querySelector<HTMLElement>("#branch-control-status");
const branchToggleBtn = document.querySelector<HTMLButtonElement>("#branch-toggle-btn");
const fitBtn = document.querySelector<HTMLButtonElement>("#fit-btn");
const resetBtn = document.querySelector<HTMLButtonElement>("#reset-btn");
const backToOverlayBtn = document.querySelector<HTMLButtonElement>("#back-to-overlay-btn");
const practiceBtn = document.querySelector<HTMLButtonElement>("#practice-btn");
const cyContainer = document.getElementById("cy");
const graphStatusEl = document.getElementById("graph-status");

let appData: InitialAppData | null = null;
let activeRace: PlayerRaceOption | null = null;
let activePaths: BuildOrderPath[] = [];
let activeStepGraph: StepGraphView | null = null;
let selectedPathIndex: number | null = null;
let selectedBuildNodeId: string | null = null;
let cy: Core | null = null;
let isMiddlePanning = false;
let isSidebarResizing = false;
let importModeActive = false;
let previewNewBranchId: string | null = null;
let previewParsedName: string | undefined;
let lastPanPoint = { x: 0, y: 0 };
let edgeLabelEditorEl: HTMLInputElement | null = null;
let edgeLabelEditorCleanup: (() => void) | null = null;

const IMPORT_LABEL_SUFFIX = "[imported]";

function importBranchLabel(name: string | undefined): string {
  const base = (name && name.trim()) || previewParsedName || "Imported Build";
  return `${base} ${IMPORT_LABEL_SUFFIX}`;
}

const ZOOM_STEP = 1.15;

const nodeColors: Record<string, string> = {
  step: "#2563eb",
  branch: "#7c3aed",
  terminal: "#15803d"
};

function applyViewerScale(ui: AppConfig["ui"]): void {
  const fontScale = Number.isFinite(ui.fontScale) ? Math.max(0.75, ui.fontScale) : 1;
  const configuredScale = Number.isFinite(ui.scale) ? Math.max(0.75, ui.scale) : 1;
  const viewportFactor = Math.min(1, window.innerHeight / 720, window.innerWidth / 1100);
  const combinedScale = fontScale * configuredScale * viewportFactor;
  document.documentElement.style.fontSize = `${combinedScale}rem`;
  document.documentElement.style.setProperty("--content-scale", viewportFactor.toFixed(3));
}

function setupLayoutResize(): void {
  const refreshLayout = (): void => {
    if (appData) {
      applyViewerScale(appData.config.ui);
    }
    cy?.resize();
  };

  window.addEventListener("resize", refreshLayout);

  if (layoutEl) {
    const observer = new ResizeObserver(() => {
      cy?.resize();
    });
    observer.observe(layoutEl);
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function zoomGraph(factor: number): void {
  if (!cy) {
    return;
  }

  const nextZoom = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), cy.zoom() * factor));
  cy.zoom({
    level: nextZoom,
    renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 }
  });
}

function setupGraphNavigation(): void {
  if (!cyContainer) {
    return;
  }

  cyContainer.addEventListener("mousedown", (event) => {
    if (event.button !== 1 || !cy) {
      return;
    }

    event.preventDefault();
    isMiddlePanning = true;
    lastPanPoint = { x: event.clientX, y: event.clientY };
    cyContainer.classList.add("panning");
  });

  cyContainer.addEventListener("auxclick", (event) => {
    if (event.button === 1) {
      event.preventDefault();
    }
  });

  window.addEventListener("mousemove", (event) => {
    if (!isMiddlePanning || !cy) {
      return;
    }

    const dx = event.clientX - lastPanPoint.x;
    const dy = event.clientY - lastPanPoint.y;
    cy.panBy({ x: dx, y: dy });
    lastPanPoint = { x: event.clientX, y: event.clientY };
  });

  window.addEventListener("mouseup", (event) => {
    if (event.button !== 1) {
      return;
    }

    isMiddlePanning = false;
    cyContainer.classList.remove("panning");
  });

  window.addEventListener("keydown", (event) => {
    if (!cy || isEditableTarget(event.target)) {
      return;
    }

    if (event.key === "=" || event.key === "+") {
      zoomGraph(ZOOM_STEP);
      event.preventDefault();
      return;
    }

    if (event.key === "-" || event.key === "_") {
      zoomGraph(1 / ZOOM_STEP);
      event.preventDefault();
    }
  });
}

function setupSidebarResize(): void {
  if (!sidebarResizerEl || !layoutEl) {
    return;
  }

  sidebarResizerEl.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    isSidebarResizing = true;
    sidebarResizerEl.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  window.addEventListener("mousemove", (event) => {
    if (!isSidebarResizing || !layoutEl) {
      return;
    }

    const layoutRect = layoutEl.getBoundingClientRect();
    const resizerWidth = sidebarResizerEl.offsetWidth;
    const nextWidth = layoutRect.right - event.clientX - resizerWidth;
    const clampedWidth = Math.min(560, Math.max(260, nextWidth));
    layoutEl.style.setProperty("--sidebar-width", `${clampedWidth}px`);
    cy?.resize();
  });

  window.addEventListener("mouseup", () => {
    if (!isSidebarResizing) {
      return;
    }

    isSidebarResizing = false;
    sidebarResizerEl.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    cy?.resize();
  });
}

function createCyStyles() {
  return [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        "background-color": "#334155",
        "border-width": 2,
        "border-color": "#64748b",
        color: "#f8fafc",
        label: "data(label)",
        "font-size": 10,
        "text-wrap": "wrap",
        "text-max-width": 180,
        "text-valign": "center",
        "text-halign": "center",
        padding: "10px",
        width: "label",
        height: "label"
      }
    },
    {
      selector: "node[kind = 'step']",
      style: {
        "background-color": nodeColors.step,
        "border-color": "#60a5fa"
      }
    },
    {
      selector: "node[kind = 'branch']",
      style: {
        "background-color": nodeColors.branch,
        "border-color": "#c084fc"
      }
    },
    {
      selector: "node[kind = 'terminal']",
      style: {
        "background-color": nodeColors.terminal,
        "border-color": "#4ade80"
      }
    },
    {
      selector: "node.path-active",
      style: {
        "border-width": 4,
        "border-color": "#fde047"
      }
    },
    {
      selector: "node.highlighted",
      style: {
        "border-width": 4,
        "border-color": "#f8fafc"
      }
    },
    {
      selector: "node.selected",
      style: {
        "border-width": 5,
        "border-color": "#fde047"
      }
    },
    {
      selector: "node.import-added",
      style: {
        "background-color": "#15803d",
        "border-color": "#4ade80",
        "border-width": 4,
        "border-style": "dashed",
        color: "#f0fdf4"
      }
    },
    {
      selector: "node.import-changed",
      style: {
        "border-color": "#f59e0b",
        "border-width": 4,
        "border-style": "dashed"
      }
    },
    {
      selector: "node.import-branch-point",
      style: {
        "border-color": "#fde047",
        "border-width": 5
      }
    },
    {
      selector: "edge",
      style: {
        width: 2,
        "line-color": "#64748b",
        "target-arrow-color": "#64748b",
        "target-arrow-shape": "triangle",
        "curve-style": "bezier"
      }
    },
    {
      selector: "edge[edgeKind = 'branch']",
      style: {
        "line-color": "#94a3b8",
        label: "data(label)",
        "font-size": 8,
        color: "#cbd5e1",
        "text-background-color": "#12151a",
        "text-background-opacity": 0.85,
        "text-background-padding": 2,
        "text-wrap": "wrap",
        "text-max-width": 140,
        "text-events": "yes"
      }
    },
    {
      selector: "edge.highlighted",
      style: {
        width: 3,
        "line-color": "#f8fafc",
        "target-arrow-color": "#f8fafc"
      }
    },
    {
      selector: "edge.import-added",
      style: {
        width: 3,
        "line-color": "#4ade80",
        "target-arrow-color": "#4ade80",
        "line-style": "dashed"
      }
    },
    {
      selector: "edge.import-changed",
      style: {
        width: 2.5,
        "line-color": "#f59e0b",
        "target-arrow-color": "#f59e0b",
        "line-style": "dashed"
      }
    },
    {
      selector: ".dimmed",
      style: {
        opacity: 0.18
      }
    },
    {
      selector: "node.disabled-branch",
      style: {
        "background-color": "#475569",
        "border-color": "#64748b",
        color: "#94a3b8",
        opacity: 0.35
      }
    },
    {
      selector: "edge.disabled-branch",
      style: {
        "line-color": "#475569",
        "target-arrow-color": "#475569",
        color: "#64748b",
        opacity: 0.35
      }
    }
  ] as cytoscape.StylesheetStyle[];
}

function clearHighlights(): void {
  if (!cy) {
    return;
  }
  cy.elements().removeClass("highlighted selected dimmed path-active");
}

function pathContainsStep(
  path: BuildOrderPath,
  graph: ResolvedBuildGraph,
  buildNodeId: string,
  stepIndex: number
): boolean {
  if (!path.nodePath.includes(buildNodeId)) {
    return false;
  }
  const node = graph.nodes[buildNodeId];
  return node?.type === "build" && stepIndex >= 0 && stepIndex < node.steps.length;
}

function findMatchingPaths(buildNodeId: string, stepIndex: number): BuildOrderPath[] {
  if (!activeRace) {
    return [];
  }
  return activePaths.filter((path) => pathContainsStep(path, activeRace!.graph, buildNodeId, stepIndex));
}

function getStepsThroughBuildNode(
  graph: ResolvedBuildGraph,
  path: BuildOrderPath,
  throughBuildNodeId: string
): BuildStep[] {
  const steps: BuildStep[] = [];

  for (const nodeId of path.nodePath) {
    const node = graph.nodes[nodeId];
    if (!node || node.type !== "build") {
      continue;
    }
    steps.push(...node.steps);
    if (nodeId === throughBuildNodeId) {
      break;
    }
  }

  return steps;
}

function getStepIdsThroughBuildNode(
  graph: ResolvedBuildGraph,
  path: BuildOrderPath,
  throughBuildNodeId: string
): string[] {
  const stepIds: string[] = [];

  for (const nodeId of path.nodePath) {
    const node = graph.nodes[nodeId];
    if (!node || node.type !== "build") {
      continue;
    }
    for (let index = 0; index < node.steps.length; index += 1) {
      stepIds.push(`${nodeId}::${index}`);
    }
    if (nodeId === throughBuildNodeId) {
      break;
    }
  }

  return stepIds;
}

function setPathCheckboxes(selectedIndex: number | null): void {
  if (!pathSelectorEl) {
    return;
  }
  pathSelectorEl.querySelectorAll<HTMLInputElement>("input[type='checkbox']").forEach((input, inputIndex) => {
    input.checked = selectedIndex === inputIndex;
  });
}

function getPathLabel(path: BuildOrderPath): string {
  const lastChoice = path.choices[path.choices.length - 1];
  if (lastChoice) {
    return lastChoice.label;
  }
  const leafId = path.nodePath[path.nodePath.length - 1];
  return leafId ?? "Build order";
}

function isBranchDisabled(graph: ResolvedBuildGraph, buildNodeId: string): boolean {
  const node = graph.nodes[buildNodeId];
  return node?.type === "build" && node.disabled === true;
}

/** A path is disabled when any branch along it carries the disabled flag. */
function isPathDisabled(graph: ResolvedBuildGraph, path: BuildOrderPath): boolean {
  return path.nodePath.some((nodeId) => isBranchDisabled(graph, nodeId));
}

/**
 * Build nodes still on a live path: reachable from the root without passing
 * through a disabled branch. Disabling a non-leaf branch therefore prunes its
 * whole subtree from this set, so every descendant greys out recursively.
 */
function collectActiveReachableBuildNodes(graph: ResolvedBuildGraph): Set<string> {
  const reachable = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const node = graph.nodes[nodeId];
    if (!node) {
      return;
    }

    if (node.type === "build") {
      if (node.disabled) {
        return;
      }
      reachable.add(nodeId);
      if (node.next) {
        visit(node.next);
      }
      return;
    }

    visit(node.left.target);
    visit(node.middle.target);
    if (node.right) {
      visit(node.right.target);
    }
  };

  visit(graph.rootNodeId);
  return reachable;
}

/**
 * Grey out every step that is no longer part of a live build path: either its
 * branch (or an ancestor) is disabled so it is unreachable, or its whole
 * subtree is disabled so it reaches no active leaf. Edges into those dead steps
 * are greyed too so disabled options read as severed at the decision point.
 */
function applyDisabledStyling(): void {
  if (!cy || !activeRace || !activeStepGraph) {
    return;
  }

  const graph = activeRace.graph;
  const cache = new Map<string, boolean>();
  const reachable = collectActiveReachableBuildNodes(graph);
  const disabledStepIds = new Set<string>();

  for (const [stepId, meta] of activeStepGraph.stepMeta) {
    const dead = !reachable.has(meta.buildNodeId) || !hasActiveLeaf(graph, meta.buildNodeId, undefined, cache);
    if (dead) {
      disabledStepIds.add(stepId);
      cy.$id(stepId).addClass("disabled-branch");
    }
  }

  cy.edges().forEach((edge) => {
    if (disabledStepIds.has(edge.target().id())) {
      edge.addClass("disabled-branch");
    }
  });
}

function getStepIdsForPath(path: BuildOrderPath, graph: ResolvedBuildGraph): string[] {
  const stepIds: string[] = [];

  for (const nodeId of path.nodePath) {
    const node = graph.nodes[nodeId];
    if (!node || node.type !== "build") {
      continue;
    }
    for (let index = 0; index < node.steps.length; index += 1) {
      stepIds.push(`${nodeId}::${index}`);
    }
  }

  return stepIds;
}

function renderBuildOrder(steps: BuildStep[]): void {
  if (!buildOrderEl) {
    return;
  }

  if (steps.length === 0) {
    buildOrderEl.className = "build-order muted";
    buildOrderEl.textContent = "This path has no build steps.";
    return;
  }

  const rows = steps
    .map((step) => {
      const time = step.time ?? "";
      const supply = typeof step.supply === "number" ? String(step.supply) : "";
      return `
        <div class="build-order-row">
          <span class="col-time">${time}</span>
          <span class="col-supply">${supply}</span>
          <span class="col-action">${step.action}</span>
        </div>
      `;
    })
    .join("");

  buildOrderEl.className = "build-order";
  buildOrderEl.innerHTML = `
    <div class="build-order-grid">
      <div class="build-order-header">
        <span class="col-time">Time</span>
        <span class="col-supply">Supply</span>
        <span class="col-action">Action</span>
      </div>
      ${rows}
    </div>
  `;
}

function updatePracticeButtonState(): void {
  if (!practiceBtn) {
    return;
  }
  practiceBtn.disabled = selectedPathIndex === null;
}

function clearPathSelection(): void {
  selectedPathIndex = null;
  setPathCheckboxes(null);
  updatePracticeButtonState();
  if (buildOrderEl) {
    buildOrderEl.className = "build-order muted";
    buildOrderEl.textContent = "Select a build path to view its steps.";
  }
  clearHighlights();
}

function highlightStepIds(stepIds: string[], selectedStepId: string): void {
  if (!cy) {
    return;
  }

  clearHighlights();
  const stepIdSet = new Set(stepIds);

  cy.elements().addClass("dimmed");
  stepIds.forEach((stepId) => {
    cy?.$id(stepId).removeClass("dimmed").addClass("path-active highlighted");
  });
  cy.$id(selectedStepId).removeClass("dimmed").addClass("path-active highlighted selected");

  cy.edges().forEach((edge) => {
    const source = edge.source().id();
    const target = edge.target().id();
    if (stepIdSet.has(source) && stepIdSet.has(target)) {
      edge.removeClass("dimmed").addClass("path-active highlighted");
    }
  });
}

function highlightPath(path: BuildOrderPath, selectedStepId?: string): void {
  if (!cy || !activeRace) {
    return;
  }

  clearHighlights();
  const stepIds = new Set(getStepIdsForPath(path, activeRace.graph));

  cy.elements().addClass("dimmed");
  stepIds.forEach((stepId) => {
    cy?.$id(stepId).removeClass("dimmed").addClass("path-active highlighted");
  });
  if (selectedStepId) {
    cy.$id(selectedStepId).removeClass("dimmed").addClass("path-active highlighted selected");
  }

  cy.edges().forEach((edge) => {
    const source = edge.source().id();
    const target = edge.target().id();
    if (stepIds.has(source) && stepIds.has(target)) {
      edge.removeClass("dimmed").addClass("path-active highlighted");
    }
  });
}

function selectPath(index: number): void {
  const path = activePaths[index];
  if (!path) {
    return;
  }

  selectedPathIndex = index;
  setPathCheckboxes(index);
  renderBuildOrder(path.steps);
  highlightPath(path);
  updatePracticeButtonState();
}

function syncSidebarFromStep(stepId: string, buildNodeId: string, stepIndex: number): void {
  if (!activeRace) {
    return;
  }

  const matchingPaths = findMatchingPaths(buildNodeId, stepIndex);

  if (matchingPaths.length === 1) {
    const pathIndex = activePaths.indexOf(matchingPaths[0]!);
    if (pathIndex >= 0) {
      selectedPathIndex = pathIndex;
      setPathCheckboxes(pathIndex);
      renderBuildOrder(matchingPaths[0]!.steps);
      highlightPath(matchingPaths[0]!, stepId);
      updatePracticeButtonState();
      return;
    }
  }

  selectedPathIndex = null;
  setPathCheckboxes(null);
  updatePracticeButtonState();

  const representativePath = matchingPaths[0];
  if (!representativePath) {
    if (buildOrderEl) {
      buildOrderEl.className = "build-order muted";
      buildOrderEl.textContent = "No matching build path for this step.";
    }
    highlightSubgraph(stepId);
    return;
  }

  const partialSteps = getStepsThroughBuildNode(activeRace.graph, representativePath, buildNodeId);
  renderBuildOrder(partialSteps);

  const partialStepIds = getStepIdsThroughBuildNode(activeRace.graph, representativePath, buildNodeId);
  highlightStepIds(partialStepIds, stepId);
}

function renderPathSelector(paths: BuildOrderPath[]): void {
  if (!pathSelectorEl) {
    return;
  }

  pathSelectorEl.innerHTML = "";

  if (paths.length === 0) {
    pathSelectorEl.innerHTML = `<p class="muted">No build paths found.</p>`;
    return;
  }

  const graph = activeRace?.graph;

  paths.forEach((path, index) => {
    const disabled = graph ? isPathDisabled(graph, path) : false;

    const option = document.createElement("label");
    option.className = `path-option${disabled ? " path-option-disabled" : ""}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedPathIndex === index;
    checkbox.disabled = disabled;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectPath(index);
        return;
      }
      if (selectedPathIndex === index) {
        clearPathSelection();
      }
    });

    const text = document.createElement("span");
    text.className = "path-option-text";
    text.textContent = disabled ? `${getPathLabel(path)} (disabled)` : getPathLabel(path);

    option.append(checkbox, text);
    pathSelectorEl.appendChild(option);
  });
}

function highlightSubgraph(stepId: string): void {
  if (!cy || !activeStepGraph) {
    return;
  }

  clearHighlights();
  const related = new Set<string>([
    ...collectAncestors(activeStepGraph, stepId),
    ...collectDescendants(activeStepGraph, stepId)
  ]);

  cy.elements().addClass("dimmed");
  related.forEach((id) => {
    cy?.$id(id).removeClass("dimmed").addClass("highlighted");
  });
  cy.$id(stepId).removeClass("dimmed").addClass("selected");

  cy.edges().forEach((edge) => {
    const source = edge.source().id();
    const target = edge.target().id();
    if (related.has(source) && related.has(target)) {
      edge.removeClass("dimmed").addClass("highlighted");
    }
  });
}

function renderBranchControl(buildNodeId: string | null): void {
  selectedBuildNodeId = buildNodeId;

  if (!branchControlEl || !branchControlNameEl || !branchToggleBtn) {
    return;
  }

  const node = buildNodeId && activeRace ? activeRace.graph.nodes[buildNodeId] : undefined;
  if (!buildNodeId || !node || node.type !== "build") {
    branchControlEl.hidden = true;
    if (branchControlStatusEl) {
      branchControlStatusEl.textContent = "";
      branchControlStatusEl.className = "branch-control-status";
    }
    return;
  }

  const disabled = node.disabled === true;
  branchControlEl.hidden = false;
  branchControlNameEl.textContent = node.title || buildNodeId;
  branchToggleBtn.textContent = disabled ? "Enable branch" : "Disable branch";
  branchToggleBtn.classList.toggle("is-enable", disabled);
  branchToggleBtn.disabled = false;
  if (branchControlStatusEl) {
    branchControlStatusEl.textContent = disabled
      ? "Disabled — hidden from the overlay and unavailable as a decision."
      : "";
    branchControlStatusEl.className = "branch-control-status";
  }
}

function reselectBuildNode(buildNodeId: string): void {
  if (activeStepGraph) {
    for (const [stepId, meta] of activeStepGraph.stepMeta) {
      if (meta.buildNodeId === buildNodeId) {
        selectStepNode(stepId);
        return;
      }
    }
  }
  renderBranchControl(buildNodeId);
}

async function setBranchDisabledClient(req: SetBranchDisabledRequest): Promise<SetBranchDisabledResponse> {
  if (window.overlayApi?.setBranchDisabled) {
    return window.overlayApi.setBranchDisabled(req);
  }
  const response = await fetch("/api/set-branch-disabled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req)
  });
  return (await response.json()) as SetBranchDisabledResponse;
}

async function toggleSelectedBranch(): Promise<void> {
  if (!activeRace || !selectedBuildNodeId || !branchToggleBtn) {
    return;
  }
  const buildNodeId = selectedBuildNodeId;
  const node = activeRace.graph.nodes[buildNodeId];
  if (!node || node.type !== "build") {
    return;
  }

  const nextDisabled = node.disabled !== true;
  branchToggleBtn.disabled = true;
  if (branchControlStatusEl) {
    branchControlStatusEl.textContent = nextDisabled ? "Disabling…" : "Enabling…";
    branchControlStatusEl.className = "branch-control-status";
  }

  try {
    const result = await setBranchDisabledClient({
      buildId: activeRace.buildId,
      branchId: buildNodeId,
      disabled: nextDisabled
    });

    if (!result.ok) {
      if (branchControlStatusEl) {
        branchControlStatusEl.textContent = result.error ?? "Failed to update branch.";
        branchControlStatusEl.className = "branch-control-status error";
      }
      branchToggleBtn.disabled = false;
      return;
    }

    await refreshData();
    reselectBuildNode(buildNodeId);
  } catch (error) {
    if (branchControlStatusEl) {
      branchControlStatusEl.textContent = error instanceof Error ? error.message : String(error);
      branchControlStatusEl.className = "branch-control-status error";
    }
    branchToggleBtn.disabled = false;
  }
}

function selectStepNode(stepId: string): void {
  const meta = activeStepGraph?.stepMeta.get(stepId);
  if (!meta) {
    return;
  }

  syncSidebarFromStep(stepId, meta.buildNodeId, meta.stepIndex);
  renderBranchControl(meta.buildNodeId);

  cy?.animate({
    center: { eles: cy.$id(stepId) },
    zoom: Math.max(cy.zoom(), 0.85)
  });
}

function setGraphStatus(message: string, kind: "" | "ok" | "error" = ""): void {
  if (!graphStatusEl) {
    return;
  }
  graphStatusEl.textContent = message;
  graphStatusEl.className = kind ? `graph-status ${kind}` : "graph-status";
}

function dismissEdgeLabelEditor(): void {
  edgeLabelEditorCleanup?.();
  edgeLabelEditorCleanup = null;
  edgeLabelEditorEl?.remove();
  edgeLabelEditorEl = null;
}

async function updateDecisionLabelClient(req: UpdateDecisionLabelRequest): Promise<UpdateDecisionLabelResponse> {
  if (window.overlayApi?.updateDecisionLabel) {
    return window.overlayApi.updateDecisionLabel(req);
  }
  const response = await fetch("/api/update-decision-label", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req)
  });
  return (await response.json()) as UpdateDecisionLabelResponse;
}

function positionEdgeLabelEditor(edge: cytoscape.EdgeSingular, input: HTMLInputElement): void {
  if (!cy) {
    return;
  }
  const midpoint = edge.renderedMidpoint();
  input.style.left = `${midpoint.x}px`;
  input.style.top = `${midpoint.y}px`;
}

function showEdgeLabelEditor(edge: cytoscape.EdgeSingular, decisionRef: DecisionLabelRef): void {
  if (!cy || !cyContainer || importModeActive) {
    return;
  }

  dismissEdgeLabelEditor();

  const initialLabel = edge.data("label") as string;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "edge-label-editor";
  input.value = initialLabel;
  input.setAttribute("aria-label", "Edit branch label");
  cyContainer.appendChild(input);
  edgeLabelEditorEl = input;
  positionEdgeLabelEditor(edge, input);

  let committed = false;

  const reposition = (): void => {
    positionEdgeLabelEditor(edge, input);
  };

  cy.on("pan zoom resize", reposition);

  const cleanup = (): void => {
    cy?.off("pan zoom resize", reposition);
  };
  edgeLabelEditorCleanup = cleanup;

  const commit = async (): Promise<void> => {
    if (committed) {
      return;
    }
    committed = true;

    const nextLabel = input.value.trim();
    dismissEdgeLabelEditor();

    if (nextLabel.length === 0) {
      setGraphStatus("Label cannot be empty.", "error");
      return;
    }
    if (nextLabel === initialLabel) {
      return;
    }

    setGraphStatus("Saving label…");
    try {
      const result = await updateDecisionLabelClient({
        buildId: decisionRef.buildId,
        branchId: decisionRef.branchId,
        slot: decisionRef.slot,
        label: nextLabel
      });

      if (!result.ok) {
        edge.data("label", initialLabel);
        setGraphStatus(result.error ?? "Failed to save label.", "error");
        return;
      }

      setGraphStatus("Label saved.", "ok");
      await refreshData();
    } catch (error) {
      edge.data("label", initialLabel);
      setGraphStatus(error instanceof Error ? error.message : String(error), "error");
    }
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      committed = true;
      dismissEdgeLabelEditor();
    }
  });

  input.addEventListener("blur", () => {
    void commit();
  });

  input.focus();
  input.select();
}

function setupBranchLabelEditing(): void {
  if (!cy) {
    return;
  }

  cy.on("dbltap", "edge[edgeKind = 'branch']", (event) => {
    if (importModeActive) {
      return;
    }

    const edge = event.target;
    const decisionRef = edge.data("decisionRef") as DecisionLabelRef | undefined;
    if (!decisionRef) {
      return;
    }

    event.stopPropagation();
    showEdgeLabelEditor(edge, decisionRef);
  });
}

function instantiateCy(elements: ElementDefinition[]): Core {
  dismissEdgeLabelEditor();
  if (cy) {
    cy.destroy();
  }

  return cytoscape({
    container: document.getElementById("cy"),
    elements,
    style: createCyStyles(),
    layout: {
      name: "dagre",
      rankDir: "TB",
      nodeSep: 24,
      rankSep: 18,
      edgeSep: 10,
      minLen: (edge: cytoscape.EdgeSingular) => edge.data("minLen") ?? 1,
      animate: false
    } as cytoscape.LayoutOptions,
    minZoom: 0.2,
    maxZoom: 2.5,
    wheelSensitivity: 0.2
  });
}

/**
 * Render the "no builds yet" state so the viewer is usable before anything has
 * been imported (e.g. fresh install or after clearing builds for a new patch).
 */
function showEmptyState(): void {
  activeRace = null;
  activePaths = [];
  selectedPathIndex = null;
  activeStepGraph = null;
  if (cy) {
    cy.destroy();
    cy = null;
  }
  updatePracticeButtonState();
  renderPathSelector([]);
  renderBranchControl(null);
  setGraphStatus('No builds yet. Click "Import build" to add one.');
  if (buildOrderEl) {
    buildOrderEl.className = "build-order muted";
    buildOrderEl.textContent = 'No builds yet. Use "Import build" to add one.';
  }
}

/**
 * Target build id (file) that owns a race's root: the existing file when the
 * race already has builds, otherwise a race-named file to create.
 */
function buildIdForRace(race: string): string {
  const existing = appData?.raceOptions.find((option) => option.playerRace === race);
  return existing ? existing.buildId : race;
}

function mountGraph(option: PlayerRaceOption): void {
  activeRace = option;
  activePaths = collectBuildOrders(option.graph);
  selectedPathIndex = null;
  updatePracticeButtonState();
  activeStepGraph = buildStepGraph(option.graph);
  const elements = activeStepGraph.elements as ElementDefinition[];

  cy = instantiateCy(elements);

  cy.on("tap", "node", (event) => {
    selectStepNode(event.target.id());
  });

  cy.on("tap", (event) => {
    if (event.target === cy) {
      resetSelection();
    }
  });

  setupBranchLabelEditing();
  setGraphStatus("Double-click a branch label to rename it.");

  renderPathSelector(activePaths);
  renderBranchControl(null);
  applyDisabledStyling();
  if (buildOrderEl) {
    buildOrderEl.className = "build-order muted";
    buildOrderEl.textContent = "Select a build path to view its steps.";
  }

  cy.ready(() => {
    cy?.fit(undefined, 40);
  });
}

/**
 * Render the proposed merge graph (preview mode): the patched build resolved
 * into a step graph, with the imported branch and changed structure highlighted
 * so the diff is visible right at the branch point. Does not touch the browse
 * state (activeRace/activePaths) so it can be restored on cancel.
 */
function mountPreviewGraph(patchedGraph: ResolvedBuildGraph, newBranchId: string): void {
  const previewStepGraph = buildStepGraph(patchedGraph);
  const elements = previewStepGraph.elements as ElementDefinition[];

  cy = instantiateCy(elements);
  previewNewBranchId = newBranchId;

  const originalIds = new Set<string>(activeStepGraph ? activeStepGraph.stepMeta.keys() : []);
  const addedPrefix = `${newBranchId}::`;
  const addedIds = new Set<string>();

  cy.nodes().forEach((node) => {
    const id = node.id();
    if (originalIds.has(id)) {
      return;
    }
    if (id.startsWith(addedPrefix)) {
      node.addClass("import-added");
      addedIds.add(id);
    } else {
      node.addClass("import-changed");
    }
  });

  cy.edges().forEach((edge) => {
    const source = edge.source().id();
    const target = edge.target().id();
    const sourceNew = !originalIds.has(source);
    const targetNew = !originalIds.has(target);
    if (target.startsWith(addedPrefix) || source.startsWith(addedPrefix)) {
      edge.addClass("import-added");
    } else if (sourceNew && targetNew) {
      edge.addClass("import-changed");
    }
  });

  // Mark the step the import branches off from (parent of the first imported
  // node) so the divergence point is obvious. This is an existing shared step
  // for split/decision merges, or the synthesized start anchor at the root.
  const firstAddedId = `${newBranchId}::0`;
  const branchPointEles = cy.$id(firstAddedId).incomers("node");
  branchPointEles.forEach((node) => {
    node.removeClass("import-changed");
    node.addClass("import-branch-point");
  });

  cy.ready(() => {
    if (!cy) {
      return;
    }
    const focus = cy.collection().union(branchPointEles);
    addedIds.forEach((id) => {
      focus.merge(cy!.$id(id));
    });
    if (focus.nonempty()) {
      cy.fit(focus, 80);
    } else {
      cy.fit(undefined, 40);
    }
  });
}

/**
 * Live-update the imported branch's edge label in the preview graph as the
 * author edits the name field, without recomputing the whole merge.
 */
function updateImportBranchLabel(name: string | undefined): void {
  if (!cy || !previewNewBranchId) {
    return;
  }
  const firstAddedId = `${previewNewBranchId}::0`;
  const label = importBranchLabel(name);
  cy.edges().forEach((edge) => {
    if (edge.data("edgeKind") === "branch" && edge.target().id() === firstAddedId) {
      edge.data("label", label);
    }
  });
}

function clearPreviewGraphState(): void {
  previewNewBranchId = null;
  previewParsedName = undefined;
}

function resetSelection(): void {
  clearPathSelection();
  renderBranchControl(null);
}

function renderRaceTabs(options: PlayerRaceOption[]): void {
  if (!raceTabsEl) {
    return;
  }

  raceTabsEl.innerHTML = "";
  options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `race-tab${index === 0 ? " active" : ""}`;
    button.textContent = option.label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", index === 0 ? "true" : "false");
    button.addEventListener("click", () => {
      raceTabsEl.querySelectorAll(".race-tab").forEach((tab) => {
        tab.classList.remove("active");
        tab.setAttribute("aria-selected", "false");
      });
      button.classList.add("active");
      button.setAttribute("aria-selected", "true");
      mountGraph(option);
    });
    raceTabsEl.appendChild(button);
  });
}

async function loadInitialData(): Promise<InitialAppData> {
  if (window.overlayApi) {
    return window.overlayApi.getInitialData();
  }

  const response = await fetch("/api/graphs");
  const payload = (await response.json()) as InitialAppData | { error: string };

  if (!response.ok || "error" in payload) {
    throw new Error("error" in payload ? payload.error : `Request failed (${response.status})`);
  }

  return payload;
}

async function bootstrap(): Promise<void> {
  try {
    if (backToOverlayBtn && window.overlayApi) {
      backToOverlayBtn.classList.remove("is-hidden");
      backToOverlayBtn.addEventListener("click", () => {
        void window.overlayApi.showOverlay();
      });
    }

    appData = await loadInitialData();
    applyViewerScale(appData.config.ui);
    renderRaceTabs(appData.raceOptions);
    if (appData.raceOptions.length > 0) {
      mountGraph(appData.raceOptions[0]);
    } else {
      showEmptyState();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pathSelectorEl) {
      pathSelectorEl.innerHTML = `<p class="muted">Failed to load build graphs: ${message}</p>`;
    }
    console.error(message);
  }
}

fitBtn?.addEventListener("click", () => {
  cy?.fit(undefined, 40);
});

resetBtn?.addEventListener("click", () => {
  resetSelection();
});

branchToggleBtn?.addEventListener("click", () => void toggleSelectedBranch());

practiceBtn?.addEventListener("click", () => {
  if (!activeRace || selectedPathIndex === null || !window.overlayApi) {
    return;
  }

  const path = activePaths[selectedPathIndex];
  if (!path) {
    return;
  }

  const config = practiceConfigFromPath(activeRace, path);
  void window.overlayApi.startPractice(config);
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const IMPORT_ACTION_LABELS: Record<string, string> = {
  "new-root-child": "Branches at the race root (no shared prefix found)",
  "split-branch": "Splits an existing branch at the divergence point",
  "add-decision-option": "Adds a new option to an existing decision",
  extend: "Extends an existing build path"
};

async function importClient(request: ImportRequest): Promise<ImportResponse> {
  if (window.overlayApi?.importBuild) {
    return window.overlayApi.importBuild(request);
  }
  const response = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  return (await response.json()) as ImportResponse;
}

function renderImportResult(target: HTMLElement, result: ImportResponse): void {
  if (!result.ok) {
    target.innerHTML = `<div class="result-summary"><span class="result-badge error">Error</span><span>${escapeHtml(
      result.error ?? "Import failed."
    )}</span></div>`;
    return;
  }

  const blocks: string[] = [];
  const valid = (result.validationErrors?.length ?? 0) === 0;
  const warnings = [...(result.parserWarnings ?? []), ...(result.planWarnings ?? [])];

  const summaryParts: string[] = [
    `<span class="result-badge ${valid ? "ok" : "error"}">${valid ? "Valid" : "Invalid"}</span>`,
    `<span>${escapeHtml(IMPORT_ACTION_LABELS[result.action ?? ""] ?? result.action ?? "")}</span>`
  ];
  if (warnings.length > 0) {
    summaryParts.push(`<span class="result-badge warn">${warnings.length} warning(s)</span>`);
  }
  blocks.push(`<div class="result-summary">${summaryParts.join("")}</div>`);

  const matchNote =
    result.matchedStepCount != null && result.divergeNodeId
      ? `Matched ${result.matchedStepCount} step(s); diverges at <strong>${escapeHtml(
          result.divergeNodeId
        )}</strong> step ${result.divergeStepIndex ?? 0}.`
      : "No shared prefix; the import becomes a new option at the race root.";
  blocks.push(
    `<div class="result-note">${escapeHtml(result.format ?? "")} &middot; ${result.stepsParsed ?? 0} steps parsed &middot; new branch <strong>${escapeHtml(
      result.newBranchId ?? ""
    )}</strong>.<br>${matchNote}</div>`
  );

  if (warnings.length > 0) {
    blocks.push(`<ul class="warn-list">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`);
  }
  if (!valid) {
    blocks.push(
      `<ul class="error-list">${(result.validationErrors ?? [])
        .map((e) => `<li>${escapeHtml(e)}</li>`)
        .join("")}</ul>`
    );
  }

  if (result.diff) {
    const added = new Set(result.diff.addedBranches);
    const lines: string[] = ['<div class="diff-block">'];
    let currentBranch = "";
    for (const step of result.diff.steps) {
      if (step.branchId !== currentBranch) {
        currentBranch = step.branchId;
        const tag = added.has(currentBranch)
          ? '<span class="diff-tag added">new branch</span>'
          : '<span class="diff-tag">modified</span>';
        lines.push(
          `<div class="diff-branch"><span class="diff-branch-name">${escapeHtml(currentBranch)}</span>${tag}</div>`
        );
      }
      const marker = step.kind === "added" ? "+" : "\u00a0";
      lines.push(`<div class="diff-line ${step.kind}">${marker} ${escapeHtml(step.text)}</div>`);
    }
    lines.push("</div>");
    blocks.push(lines.join(""));
  }

  target.innerHTML = blocks.join("");
}

function setupImport(): void {
  const importBtn = document.getElementById("import-btn");
  const browsePanel = document.getElementById("browse-panel");
  const importPanel = document.getElementById("import-panel");
  const closeBtn = document.getElementById("import-close");
  const previewBtn = document.getElementById("import-preview-btn");
  const applyBtn = document.getElementById("import-apply") as HTMLButtonElement | null;
  const textEl = document.getElementById("import-text") as HTMLTextAreaElement | null;
  const nameEl = document.getElementById("import-name") as HTMLInputElement | null;
  const raceEl = document.getElementById("import-race") as HTMLSelectElement | null;
  const keepWorkersEl = document.getElementById("import-keep-workers") as HTMLInputElement | null;
  const resultEl = document.getElementById("import-result");
  const statusEl = document.getElementById("import-status");

  if (!importBtn || !browsePanel || !importPanel || !textEl || !resultEl || !applyBtn || !statusEl) {
    return;
  }

  let canApply = false;

  const setStatus = (message: string, kind: "" | "ok" | "error" = ""): void => {
    statusEl.textContent = message;
    statusEl.className = `import-status${kind ? ` ${kind}` : ""}`;
  };

  const clearPreviewState = (): void => {
    canApply = false;
    applyBtn.disabled = true;
    resultEl.classList.add("is-hidden");
    resultEl.innerHTML = "";
    clearPreviewGraphState();
    setStatus("");
  };

  const enterImportMode = (): void => {
    importModeActive = true;
    browsePanel.classList.add("is-hidden");
    importPanel.classList.remove("is-hidden");
    importBtn.classList.add("is-active");
    clearPreviewState();
    // Default the race selector to whatever the user is currently viewing.
    if (raceEl && activeRace) {
      raceEl.value = activeRace.playerRace;
    }
    textEl.focus();
  };

  const exitImportMode = (): void => {
    importModeActive = false;
    importPanel.classList.add("is-hidden");
    browsePanel.classList.remove("is-hidden");
    importBtn.classList.remove("is-active");
    clearPreviewState();
    if (activeRace) {
      mountGraph(activeRace);
    } else {
      showEmptyState();
    }
  };

  const buildRequest = (apply: boolean): ImportRequest | null => {
    const race = (raceEl?.value || activeRace?.playerRace) as ImportRequest["race"] | undefined;
    if (!race) {
      setStatus("Select a race first.", "error");
      return null;
    }
    return {
      text: textEl.value,
      buildId: buildIdForRace(race),
      race,
      name: nameEl?.value || undefined,
      keepWorkers: Boolean(keepWorkersEl?.checked),
      apply
    };
  };

  const runPreview = async (): Promise<void> => {
    const request = buildRequest(false);
    if (!request) {
      return;
    }
    setStatus("Computing merge…");
    applyBtn.disabled = true;
    canApply = false;
    try {
      const result = await importClient(request);
      resultEl.classList.remove("is-hidden");
      renderImportResult(resultEl, result);
      canApply = result.ok && (result.validationErrors?.length ?? 0) === 0;
      applyBtn.disabled = !canApply;
      previewParsedName = result.name;

      if (result.ok && result.patchedGraph && result.newBranchId) {
        mountPreviewGraph(result.patchedGraph, result.newBranchId);
        // Reflect whatever is currently typed in the name field immediately.
        updateImportBranchLabel(nameEl?.value);
        setStatus("Previewing merge — green is the imported branch.", "ok");
      } else if (canApply) {
        // Valid plan but no resolvable graph (rare); keep the browse graph.
        setStatus("Merge computed (graph preview unavailable).", "ok");
      } else {
        setStatus(result.ok ? "Could not preview the merge graph." : "Could not compute a merge.", "error");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const runApply = async (): Promise<void> => {
    if (!canApply) {
      return;
    }
    const request = buildRequest(true);
    if (!request) {
      return;
    }
    setStatus("Applying merge…");
    applyBtn.disabled = true;
    try {
      const result = await importClient(request);
      if (result.ok && result.applied) {
        importModeActive = false;
        textEl.value = "";
        importPanel.classList.add("is-hidden");
        browsePanel.classList.remove("is-hidden");
        importBtn.classList.remove("is-active");
        clearPreviewState();
        setStatus("Merge applied. Refreshing graph…", "ok");
        await refreshData();
      } else {
        renderImportResult(resultEl, result);
        setStatus("Merge was not applied.", "error");
        applyBtn.disabled = false;
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "error");
    }
  };

  importBtn.addEventListener("click", () => {
    if (importModeActive) {
      exitImportMode();
    } else {
      enterImportMode();
    }
  });
  closeBtn?.addEventListener("click", exitImportMode);
  previewBtn?.addEventListener("click", () => void runPreview());
  applyBtn.addEventListener("click", () => void runApply());
  nameEl?.addEventListener("input", () => updateImportBranchLabel(nameEl.value));
  // Changing the target race invalidates any computed preview.
  raceEl?.addEventListener("change", () => clearPreviewState());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && importModeActive && !isEditableTarget(event.target)) {
      exitImportMode();
    }
  });
}

async function refreshData(): Promise<void> {
  const previousRace = activeRace?.playerRace;
  appData = await loadInitialData();
  renderRaceTabs(appData.raceOptions);
  const targetIndex = Math.max(
    0,
    appData.raceOptions.findIndex((option) => option.playerRace === previousRace)
  );
  if (appData.raceOptions.length === 0) {
    showEmptyState();
    return;
  }
  const tabs = raceTabsEl?.querySelectorAll<HTMLButtonElement>(".race-tab");
  if (tabs && tabs[targetIndex]) {
    tabs[targetIndex].click();
  } else if (appData.raceOptions[targetIndex]) {
    mountGraph(appData.raceOptions[targetIndex]);
  }
}

setupGraphNavigation();
setupSidebarResize();
setupLayoutResize();
setupImport();
void bootstrap();
