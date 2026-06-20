import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { AppConfig, BuildStep, InitialAppData, PlayerRaceOption, ResolvedBuildGraph } from "../core/types";
import { collectBuildOrders, type BuildOrderPath } from "../core/graph-traversal";
import { practiceConfigFromPath } from "../core/practice-session";
import {
  buildStepGraph,
  collectAncestors,
  collectDescendants,
  type StepGraphView
} from "./graph-viz";

cytoscape.use(dagre);

const raceTabsEl = document.querySelector<HTMLElement>("#race-tabs");
const layoutEl = document.querySelector<HTMLElement>(".layout");
const sidebarResizerEl = document.getElementById("sidebar-resizer");
const pathSelectorEl = document.querySelector<HTMLElement>("#path-selector");
const buildOrderEl = document.querySelector<HTMLElement>("#build-order");
const fitBtn = document.querySelector<HTMLButtonElement>("#fit-btn");
const resetBtn = document.querySelector<HTMLButtonElement>("#reset-btn");
const backToOverlayBtn = document.querySelector<HTMLButtonElement>("#back-to-overlay-btn");
const practiceBtn = document.querySelector<HTMLButtonElement>("#practice-btn");
const cyContainer = document.getElementById("cy");

let appData: InitialAppData | null = null;
let activeRace: PlayerRaceOption | null = null;
let activePaths: BuildOrderPath[] = [];
let activeStepGraph: StepGraphView | null = null;
let selectedPathIndex: number | null = null;
let cy: Core | null = null;
let isMiddlePanning = false;
let isSidebarResizing = false;
let lastPanPoint = { x: 0, y: 0 };

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
        "text-max-width": 140
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
      selector: ".dimmed",
      style: {
        opacity: 0.18
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

  paths.forEach((path, index) => {
    const option = document.createElement("label");
    option.className = "path-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedPathIndex === index;
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
    text.textContent = getPathLabel(path);

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

function selectStepNode(stepId: string): void {
  const meta = activeStepGraph?.stepMeta.get(stepId);
  if (!meta) {
    return;
  }

  syncSidebarFromStep(stepId, meta.buildNodeId, meta.stepIndex);

  cy?.animate({
    center: { eles: cy.$id(stepId) },
    zoom: Math.max(cy.zoom(), 0.85)
  });
}

function mountGraph(option: PlayerRaceOption): void {
  activeRace = option;
  activePaths = collectBuildOrders(option.graph);
  selectedPathIndex = null;
  updatePracticeButtonState();
  activeStepGraph = buildStepGraph(option.graph);
  const elements = activeStepGraph.elements as ElementDefinition[];

  if (cy) {
    cy.destroy();
  }

  cy = cytoscape({
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

  cy.on("tap", "node", (event) => {
    selectStepNode(event.target.id());
  });

  cy.on("tap", (event) => {
    if (event.target === cy) {
      resetSelection();
    }
  });

  renderPathSelector(activePaths);
  if (buildOrderEl) {
    buildOrderEl.className = "build-order muted";
    buildOrderEl.textContent = "Select a build path to view its steps.";
  }

  cy.ready(() => {
    cy?.fit(undefined, 40);
  });
}

function resetSelection(): void {
  clearPathSelection();
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
    mountGraph(appData.raceOptions[0]);
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

setupGraphNavigation();
setupSidebarResize();
setupLayoutResize();
void bootstrap();
