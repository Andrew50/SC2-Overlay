import type {
  BuildNode,
  ControlAction,
  DecisionNodeEntry,
  InitialAppData,
  OpponentRace,
  OpponentRaceOption,
  ResolvedBuildGraph
} from "./core/types";

const VISIBLE_QUEUE_COUNT = 5;
const DECISION_TIMEOUT_SECONDS = 10;
const ENTRY_GRACE_SECONDS = 5;

interface AppState {
  data: InitialAppData;
  activeGraph?: ResolvedBuildGraph;
  selectedOpponentRace?: OpponentRace;
  currentNodeId?: string;
  currentStepIndex: number;
  timerSeconds: number;
  timerPaused: boolean;
  timerStarted: boolean;
  currentBranchLabel: string;
  timeoutHandle?: number;
}

interface DecisionChoice {
  key: "left" | "middle" | "right";
  label: string;
  target?: string;
}

interface BuildQueueItem {
  kind: "build";
  isCurrent: boolean;
  isPastDue?: boolean;
  action: string;
  time?: string;
  supply?: number;
}

interface SelectionQueueItem {
  kind: "selection";
  isCurrent: boolean;
  hotkey: string;
  label: string;
}

type QueueItem = BuildQueueItem | SelectionQueueItem;

const els = {
  timerValue: document.querySelector<HTMLElement>("#timer-value"),
  branchValue: document.querySelector<HTMLElement>("#branch-value"),
  setupControls: document.querySelector<HTMLElement>("#setup-controls"),
  openBuildsButton: document.querySelector<HTMLButtonElement>("#open-builds-button"),
  reloadDataButton: document.querySelector<HTMLButtonElement>("#reload-data-button"),
  reloadStatus: document.querySelector<HTMLElement>("#reload-status"),
  actionQueue: document.querySelector<HTMLElement>("#action-queue"),
  upcomingDecisions: document.querySelector<HTMLElement>("#upcoming-decisions"),
  decisionContent: document.querySelector<HTMLElement>("#decision-content"),
  overlayPanel: document.querySelector<HTMLElement>(".overlay-panel")
};

function assertElement<T extends Element>(el: T | null, key: string): T {
  if (!el) {
    throw new Error(`Missing required element: ${key}`);
  }
  return el;
}

function toSeconds(value?: string): number {
  if (!value) {
    return 0;
  }
  const trimmed = value.trim();
  const minuteOnly = Number(trimmed);
  if (Number.isFinite(minuteOnly)) {
    return minuteOnly * 60;
  }

  const parts = trimmed.split(":").map((entry) => Number(entry));
  if (parts.length === 2 && parts.every((entry) => Number.isFinite(entry))) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

function stepTimeSeconds(value?: string): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  return toSeconds(value);
}

function formatSeconds(totalSeconds: number): string {
  const bounded = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(bounded / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (bounded % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMeta(time?: string, supply?: number): string {
  const timeText = time ?? "--:--";
  const supplyText = typeof supply === "number" ? `${supply}` : "--";
  return `${supplyText} | ${timeText}`;
}

function formatHotkey(value: string): string {
  return `[${value.toUpperCase()}]`;
}

function formatRaceLabel(playerRace: string, opponentRace?: string): string {
  if (!opponentRace) {
    return "Select Opponent Race";
  }
  return `${playerRace.toUpperCase()} vs ${opponentRace.toUpperCase()}`;
}

function setReloadStatus(message: string, isError = false): void {
  const reloadStatus = els.reloadStatus;
  if (!reloadStatus) {
    return;
  }
  reloadStatus.textContent = message;
  reloadStatus.classList.toggle("is-error", isError);
}

function applyUiScale(fontScale: number, scale: number): void {
  const normalizedFontScale = Number.isFinite(fontScale) ? Math.max(0.1, fontScale) : 1;
  const normalizedScale = Number.isFinite(scale) ? Math.max(0.1, scale) : 1;
  document.documentElement.style.fontSize = `${normalizedFontScale}rem`;

  const panel = assertElement(els.overlayPanel, "overlay-panel");
  panel.style.transformOrigin = "top left";
  panel.style.transform = `scale(${normalizedScale})`;
}

function getCurrentNode(state: AppState): BuildNode | undefined {
  if (!state.activeGraph || !state.currentNodeId) {
    return undefined;
  }
  return state.activeGraph.nodes[state.currentNodeId];
}

function getDecisionChoices(node: DecisionNodeEntry): DecisionChoice[] {
  const choices: DecisionChoice[] = [
    { key: "left", label: node.left.label, target: node.left.target }
  ];
  choices.push({ key: "middle", label: node.middle.label, target: node.middle.target });
  if (node.right) {
    choices.push({ key: "right", label: node.right.label, target: node.right.target });
  }
  return choices;
}

function getOpeningRaceChoices(state: AppState): DecisionChoice[] {
  return state.data.raceOptions.slice(0, 3).map((option, index) => {
    const slot = index === 0 ? "left" : index === 1 ? "middle" : "right";
    return {
      key: slot,
      label: option.label
    } as DecisionChoice;
  });
}

function getChoiceHotkey(state: AppState, key: DecisionChoice["key"]): string {
  const configured = state.data.config.hotkeys.focused[key];
  return formatHotkey(configured || key);
}

function selectOpponentRace(state: AppState, branch: "left" | "middle" | "right"): void {
  const options = state.data.raceOptions.slice(0, 3);
  const indexByBranch: Record<"left" | "middle" | "right", number> = {
    left: 0,
    middle: 1,
    right: 2
  };
  const picked = options[indexByBranch[branch]] ?? options[0];
  if (!picked) {
    return;
  }
  activateGraphForRace(state, picked);
}

function activateGraphForRace(state: AppState, option: OpponentRaceOption): void {
  state.activeGraph = option.graph;
  state.selectedOpponentRace = option.race;
  state.currentNodeId = option.graph.rootNodeId;
  state.currentStepIndex = 0;
  state.timerSeconds = 0;
  state.timerPaused = false;
  state.timerStarted = true;
  state.currentBranchLabel = formatRaceLabel(state.data.config.playerRace, option.race);
  window.clearTimeout(state.timeoutHandle);
  alignProgressToGameTime(state);
  render(state);
}

function chooseDecisionBranch(state: AppState, branch: "left" | "middle" | "right"): void {
  const node = getCurrentNode(state);
  if (!node || node.type !== "decision") {
    return;
  }
  const choices = getDecisionChoices(node);
  const picked = choices.find((choice) => choice.key === branch && choice.target);
  if (!picked?.target) {
    return;
  }
  state.currentBranchLabel = picked.label;
  state.currentNodeId = picked.target;
  state.currentStepIndex = 0;
  window.clearTimeout(state.timeoutHandle);
  alignProgressToGameTime(state);
  render(state);
}

function alignProgressToGameTime(state: AppState): void {
  if (!state.activeGraph || !state.currentNodeId) {
    return;
  }

  const visited = new Set<string>();
  while (state.currentNodeId && !visited.has(state.currentNodeId)) {
    visited.add(state.currentNodeId);
    const node: BuildNode | undefined = state.activeGraph.nodes[state.currentNodeId];
    if (!node) {
      return;
    }
    if (node.type === "decision") {
      return;
    }

    const nextIndex = node.steps.findIndex((step: { time?: string }) => {
      return stepTimeSeconds(step.time) >= state.timerSeconds;
    });
    if (nextIndex >= 0) {
      state.currentStepIndex = nextIndex;
      return;
    }

    if (!node.next) {
      state.currentStepIndex = Math.max(0, node.steps.length - 1);
      return;
    }

    state.currentNodeId = node.next;
    state.currentStepIndex = 0;
  }
}

function collectQueueItems(state: AppState, count: number): QueueItem[] {
  if (!state.activeGraph || !state.currentNodeId) {
    return [];
  }

  const activeNodeId = state.currentNodeId;
  const activeStepIndex = state.currentStepIndex;
  const activeNode = state.activeGraph.nodes[activeNodeId];
  const stickyPastItems: QueueItem[] = [];

  if (activeNode?.type === "build" && activeStepIndex > 0) {
    for (let index = 0; index < activeStepIndex; index += 1) {
      const step = activeNode.steps[index];
      const stepSeconds = stepTimeSeconds(step.time);
      if (!Number.isFinite(stepSeconds)) {
        continue;
      }
      if (state.timerSeconds <= stepSeconds + ENTRY_GRACE_SECONDS) {
        stickyPastItems.push({
          kind: "build",
          isCurrent: false,
          isPastDue: true,
          action: step.action,
          time: step.time,
          supply: step.supply
        });
      }
    }
  }

  const items: QueueItem[] = [];
  let nodeId = activeNodeId;
  let stepIndex = activeStepIndex;

  while (items.length < count) {
    const node = state.activeGraph.nodes[nodeId];
    if (!node) {
      break;
    }

    if (node.type === "build") {
      for (let index = stepIndex; index < node.steps.length && items.length < count; index += 1) {
        const step = node.steps[index];
        items.push({
          kind: "build",
          isCurrent: nodeId === activeNodeId && index === activeStepIndex,
          action: step.action,
          time: step.time,
          supply: step.supply
        });
      }
      if (items.length >= count || !node.next) {
        break;
      }
      nodeId = node.next;
      stepIndex = 0;
      continue;
    }

    const choices = getDecisionChoices(node);
    for (const choice of choices) {
      if (items.length >= count) {
        break;
      }
      items.push({
        kind: "selection",
        isCurrent: nodeId === activeNodeId && choice.key === "left",
        hotkey: getChoiceHotkey(state, choice.key),
        label: choice.label
      });
    }
    break;
  }

  const combined = [...stickyPastItems, ...items];
  const currentIndex = combined.findIndex((item) => item.isCurrent);
  if (currentIndex >= count) {
    const start = currentIndex - (count - 1);
    return combined.slice(start, start + count);
  }
  return combined.slice(0, count);
}

function renderQueueBlocks(queueItems: QueueItem[]): string {
  const rows: string[] = [];
  for (let index = 0; index < VISIBLE_QUEUE_COUNT; index += 1) {
    const item = queueItems[index];
    if (!item) {
      rows.push(`
        <article class="action-block is-placeholder">
          <span class="action-text">--</span>
          <span class="action-meta">-- | --:--</span>
        </article>
      `);
      continue;
    }

    const itemText = item.kind === "build" ? item.action : item.label;
    const itemMeta = item.kind === "build" ? formatMeta(item.time, item.supply) : item.hotkey;
    const currentClass = item.isCurrent ? " is-current" : "";
    const selectionClass = item.kind === "selection" ? " is-selection" : "";
    const pastDueClass = item.kind === "build" && item.isPastDue ? " is-past-due" : "";
    if (item.kind === "build") {
      rows.push(`
        <article class="action-block${currentClass}${selectionClass}${pastDueClass}">
          <span class="action-text">${escapeHtml(itemText)}</span>
          <span class="action-meta">${escapeHtml(itemMeta)}</span>
        </article>
      `);
      continue;
    }

    rows.push(`
      <article class="action-block${currentClass}${selectionClass}${pastDueClass}">
        <span class="action-meta">${escapeHtml(itemMeta)}</span>
        <span class="action-text">${escapeHtml(itemText)}</span>
      </article>
    `);
  }
  return rows.join("");
}

function renderSelectionRows(state: AppState, choices: DecisionChoice[]): string {
  const rows: QueueItem[] = choices.map((choice, index) => {
    return {
      kind: "selection",
      isCurrent: index === 0,
      hotkey: getChoiceHotkey(state, choice.key),
      label: choice.label
    };
  });
  return renderQueueBlocks(rows);
}

function setActionQueueHtml(actionQueue: HTMLElement, html: string): void {
  actionQueue.innerHTML = html;
}

function maybeArmDecisionTimeout(state: AppState): void {
  window.clearTimeout(state.timeoutHandle);
  if (!state.timerStarted) {
    return;
  }
  state.timeoutHandle = window.setTimeout(() => {
    const node = getCurrentNode(state);
    if (node?.type === "decision") {
      chooseDecisionBranch(state, "left");
    }
  }, DECISION_TIMEOUT_SECONDS * 1000);
}

function render(state: AppState): void {
  const timerValue = assertElement(els.timerValue, "timer-value");
  const branchValue = assertElement(els.branchValue, "branch-value");
  const actionQueue = assertElement(els.actionQueue, "action-queue");
  const upcomingDecisions = assertElement(els.upcomingDecisions, "upcoming-decisions");
  const decisionContent = assertElement(els.decisionContent, "decision-content");

  timerValue.textContent = formatSeconds(state.timerSeconds);
  branchValue.textContent = state.currentBranchLabel;
  els.setupControls?.classList.toggle("is-hidden", state.timerStarted);
  els.reloadStatus?.classList.toggle("is-hidden", state.timerStarted);
  upcomingDecisions.innerHTML = "";
  decisionContent.innerHTML = "";

  if (!state.timerStarted) {
    setActionQueueHtml(actionQueue, renderSelectionRows(state, getOpeningRaceChoices(state)));
    maybeArmDecisionTimeout(state);
    return;
  }

  const node = getCurrentNode(state);
  if (node?.type === "decision") {
    setActionQueueHtml(actionQueue, renderSelectionRows(state, getDecisionChoices(node)));
    maybeArmDecisionTimeout(state);
    return;
  }

  setActionQueueHtml(actionQueue, renderQueueBlocks(collectQueueItems(state, VISIBLE_QUEUE_COUNT)));
  window.clearTimeout(state.timeoutHandle);
}

function advanceToNextBuildItem(state: AppState): void {
  const node = getCurrentNode(state);
  if (!state.activeGraph || !node || node.type !== "build") {
    return;
  }

  if (state.currentStepIndex < node.steps.length - 1) {
    state.currentStepIndex += 1;
    const nextStep = node.steps[state.currentStepIndex];
    if (nextStep?.time) {
      state.timerSeconds = toSeconds(nextStep.time);
    }
    return;
  }

  let nextNodeId = node.next;
  const visited = new Set<string>();

  while (nextNodeId && !visited.has(nextNodeId)) {
    visited.add(nextNodeId);
    const nextNode = state.activeGraph.nodes[nextNodeId];
    if (!nextNode) {
      return;
    }

    state.currentNodeId = nextNodeId;
    state.currentStepIndex = 0;

    if (nextNode.type === "decision") {
      if (nextNode.time) {
        state.timerSeconds = toSeconds(nextNode.time);
      }
      return;
    }

    const firstStep = nextNode.steps[0];
    if (firstStep?.time) {
      state.timerSeconds = toSeconds(firstStep.time);
    }
    return;
  }
}

function handleAction(state: AppState, action: ControlAction): void {
  const node = getCurrentNode(state);

  if (action === "reset") {
    state.activeGraph = undefined;
    state.selectedOpponentRace = undefined;
    state.currentNodeId = undefined;
    state.currentStepIndex = 0;
    state.timerSeconds = 0;
    state.timerPaused = false;
    state.timerStarted = false;
    state.currentBranchLabel = formatRaceLabel(state.data.config.playerRace);
    window.clearTimeout(state.timeoutHandle);
    render(state);
    return;
  }

  if (!state.timerStarted) {
    if (action === "left" || action === "middle" || action === "right") {
      selectOpponentRace(state, action);
    }
    return;
  }

  if (action === "pause") {
    state.timerPaused = !state.timerPaused;
    render(state);
    return;
  }

  if (action === "next") {
    advanceToNextBuildItem(state);
    render(state);
    return;
  }

  if (node?.type === "decision" && (action === "left" || action === "middle" || action === "right")) {
    chooseDecisionBranch(state, action);
    return;
  }

  if (action === "left" || action === "right") {
    const delta = state.data.config.timer.adjustSeconds;
    state.timerSeconds = Math.max(0, state.timerSeconds + (action === "left" ? -delta : delta));
    alignProgressToGameTime(state);
    render(state);
  }
}

function setupFocusedFallback(state: AppState): void {
  window.addEventListener("keydown", (event) => {
    const focusedHotkeys = state.data.config.hotkeys.focused;
    const actionByKey = new Map<string, ControlAction>([
      [focusedHotkeys.left.toLowerCase(), "left"],
      [focusedHotkeys.middle.toLowerCase(), "middle"],
      [focusedHotkeys.right.toLowerCase(), "right"],
      [focusedHotkeys.pause.toLowerCase(), "pause"],
      [focusedHotkeys.reset.toLowerCase(), "reset"],
      [focusedHotkeys.next.toLowerCase(), "next"]
    ]);
    const action = actionByKey.get(event.code.toLowerCase()) ?? actionByKey.get(event.key.toLowerCase());
    if (!action) {
      return;
    }
    event.preventDefault();
    handleAction(state, action);
  });
}

function applyReloadedData(state: AppState, data: InitialAppData): void {
  const previousRace = state.selectedOpponentRace;
  const previousTimerSeconds = state.timerSeconds;
  const previousTimerPaused = state.timerPaused;
  const hadStarted = state.timerStarted;

  state.data = data;
  applyUiScale(data.config.ui.fontScale, data.config.ui.scale);

  if (hadStarted) {
    const nextOption =
      data.raceOptions.find((option) => option.race === previousRace) ?? data.raceOptions[0];
    if (nextOption) {
      activateGraphForRace(state, nextOption);
      state.timerSeconds = previousTimerSeconds;
      state.timerPaused = previousTimerPaused;
      alignProgressToGameTime(state);
      render(state);
      return;
    }
  }

  state.activeGraph = undefined;
  state.selectedOpponentRace = undefined;
  state.currentNodeId = undefined;
  state.currentStepIndex = 0;
  state.timerSeconds = 0;
  state.timerPaused = false;
  state.timerStarted = false;
  state.currentBranchLabel = formatRaceLabel(data.config.playerRace);
  window.clearTimeout(state.timeoutHandle);
  render(state);
}

function setupReloadControl(state: AppState): void {
  const reloadButton = els.reloadDataButton;
  const openBuildsButton = els.openBuildsButton;
  if (!reloadButton || !openBuildsButton) {
    return;
  }
  setReloadStatus("");

  const triggerReload = async (): Promise<void> => {
    if (state.timerStarted) {
      return;
    }
    reloadButton.disabled = true;
    setReloadStatus("Reloading data...");
    try {
      const data = await window.overlayApi.reloadData();
      applyReloadedData(state, data);
      setReloadStatus("Reloaded config/builds.");
    } catch (error) {
      setReloadStatus(`Reload failed: ${String(error)}`, true);
    } finally {
      reloadButton.disabled = false;
    }
  };

  const triggerOpenBuildsDirectory = async (): Promise<void> => {
    if (state.timerStarted) {
      return;
    }
    openBuildsButton.disabled = true;
    setReloadStatus("Opening builds folder...");
    try {
      await window.overlayApi.openBuildsDirectory();
      setReloadStatus("Opened builds folder.");
    } catch (error) {
      setReloadStatus(`Open builds failed: ${String(error)}`, true);
    } finally {
      openBuildsButton.disabled = false;
    }
  };

  reloadButton.addEventListener("click", () => {
    void triggerReload();
  });
  openBuildsButton.addEventListener("click", () => {
    void triggerOpenBuildsDirectory();
  });

  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "r") {
      return;
    }
    event.preventDefault();
    void triggerReload();
  });
}

function startTickLoop(state: AppState): void {
  window.setInterval(() => {
    if (state.timerStarted && !state.timerPaused) {
      state.timerSeconds += 1;
      alignProgressToGameTime(state);
      render(state);
    }
  }, 1000);
}

async function main(): Promise<void> {
  const data = await window.overlayApi.getInitialData();
  applyUiScale(data.config.ui.fontScale, data.config.ui.scale);

  const state: AppState = {
    data,
    currentStepIndex: 0,
    timerSeconds: 0,
    timerPaused: false,
    timerStarted: false,
    currentBranchLabel: formatRaceLabel(data.config.playerRace)
  };

  render(state);
  setupFocusedFallback(state);
  setupReloadControl(state);
  startTickLoop(state);
  window.overlayApi.onControlAction((action) => handleAction(state, action));
}

main().catch((error) => {
  const actionQueue = assertElement(els.actionQueue, "action-queue");
  actionQueue.innerHTML = `
    <article class="action-block is-current">
      <span class="action-text">Startup Error: ${escapeHtml(String(error))}</span>
      <span class="action-meta">-- | --:--</span>
    </article>
  `;
});
