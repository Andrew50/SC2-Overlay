import type {
  BuildNode,
  ControlAction,
  DecisionNodeEntry,
  InitialAppData,
  PlayerRace,
  PlayerRaceOption,
  ResolvedBuildGraph
} from "./core/types";

const VISIBLE_QUEUE_COUNT = 5;
const BRANCH_AUTO_SELECT_SECONDS = 5;
const ENTRY_GRACE_SECONDS = 5;
const IMMINENT_ACTION_WARNING_SECONDS = 5;
const COUNTDOWN_DURATION_SECONDS = 3;
const COUNTDOWN_JUMP_SECONDS = 5;
const TICK_INTERVAL_MS = 100;
const DEBUG_NAVIGATION = true;

interface AppState {
  data: InitialAppData;
  activeGraph?: ResolvedBuildGraph;
  selectedPlayerRace?: PlayerRace;
  currentNodeId?: string;
  currentStepIndex: number;
  currentActionKey?: string;
  currentActionRangeStartSeconds?: number;
  timerSeconds: number;
  timerPaused: boolean;
  timerStarted: boolean;
  currentBranchLabel: string;
  timeoutHandle?: number;
  timeoutContextKey?: string;
  timeoutStartedAtMs?: number;
  timeoutDurationMs?: number;
  pendingDecisionChoice?: DecisionChoice["key"];
  rememberedDecisionChoices: Record<string, DecisionChoice["key"]>;
  jumpHistory: JumpHistoryEntry[];
}

interface JumpHistoryEntry {
  nodeId: string;
  stepIndex: number;
  timerSeconds: number;
  currentBranchLabel: string;
  pendingDecisionChoice?: DecisionChoice["key"];
  rememberedDecisionChoices: Record<string, DecisionChoice["key"]>;
  crossedDecisionNodeIds?: string[];
  decisionNodeIdsToClearOnUndo?: string[];
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
  isImminent?: boolean;
  elapsedProgress?: number;
  action: string;
  time?: string;
  supply?: number;
}

interface SelectionQueueItem {
  kind: "selection";
  isCurrent: boolean;
  elapsedProgress?: number;
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

function formatTimerDisplay(value: number): string {
  const rounded = Math.round(value);
  const prefix = rounded < 0 ? "-" : "";
  return `${prefix}${formatSeconds(Math.abs(rounded))}`;
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

function formatRaceLabel(playerRace?: PlayerRace): string {
  if (!playerRace) {
    return "Select Your Race";
  }
  return playerRace.toUpperCase();
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

function debugNavigation(
  message: string,
  details?: Record<string, unknown> | Array<unknown> | string | number | boolean
): void {
  if (!DEBUG_NAVIGATION) {
    return;
  }
  if (typeof details === "undefined") {
    console.debug(`[overlay-nav] ${message}`);
    window.overlayApi.debugLog(`[overlay-nav] ${message}`);
    return;
  }
  console.debug(`[overlay-nav] ${message}`, details);
  window.overlayApi.debugLog(`[overlay-nav] ${message}`, details);
}

function getNavigationSnapshot(state: AppState): Record<string, unknown> {
  const node = getCurrentNode(state);
  return {
    nodeId: state.currentNodeId,
    nodeType: node?.type ?? "none",
    stepIndex: state.currentStepIndex,
    timerSeconds: Number(state.timerSeconds.toFixed(3)),
    branchLabel: state.currentBranchLabel,
    pendingDecisionChoice: state.pendingDecisionChoice ?? null,
    rememberedDecisionChoices: { ...state.rememberedDecisionChoices },
    jumpHistoryDepth: state.jumpHistory.length
  };
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

function getRememberedDecisionChoice(
  state: AppState,
  nodeId: string,
  node: DecisionNodeEntry
): DecisionChoice | undefined {
  const rememberedKey = state.rememberedDecisionChoices[nodeId];
  if (!rememberedKey) {
    return undefined;
  }
  return getDecisionChoices(node).find((choice) => choice.key === rememberedKey && Boolean(choice.target));
}

function getTraversalDecisionChoice(
  state: AppState,
  nodeId: string,
  node: DecisionNodeEntry,
  useRememberedChoices: boolean
): DecisionChoice | undefined {
  if (state.pendingDecisionChoice) {
    const pendingChoice = getDecisionChoices(node).find(
      (choice) => choice.key === state.pendingDecisionChoice && Boolean(choice.target)
    );
    if (pendingChoice) {
      return pendingChoice;
    }
  }
  if (!useRememberedChoices) {
    return undefined;
  }
  return getRememberedDecisionChoice(state, nodeId, node);
}

function getPlayerRaceChoices(state: AppState): DecisionChoice[] {
  const seen = new Set<PlayerRace>();
  const options = state.data.raceOptions.filter((option) => {
    if (seen.has(option.playerRace)) {
      return false;
    }
    seen.add(option.playerRace);
    return true;
  });
  return options.slice(0, 3).map((option, index) => {
    const slot = index === 0 ? "left" : index === 1 ? "middle" : "right";
    return {
      key: slot,
      label: option.playerRace[0].toUpperCase() + option.playerRace.slice(1)
    } as DecisionChoice;
  });
}

function getChoiceHotkey(state: AppState, key: DecisionChoice["key"]): string {
  const keyMap: Record<DecisionChoice["key"], keyof typeof state.data.config.hotkeys.focused> = {
    left: "choose1",
    middle: "choose2",
    right: "choose3"
  };
  const configured = state.data.config.hotkeys.focused[keyMap[key]];
  const fallback: Record<DecisionChoice["key"], string> = {
    left: "Choose 1",
    middle: "Choose 2",
    right: "Choose 3"
  };
  return formatHotkey(configured || fallback[key]);
}

function getBranchForChooseAction(action: ControlAction): DecisionChoice["key"] | undefined {
  if (action === "choose1") {
    return "left";
  }
  if (action === "choose2") {
    return "middle";
  }
  if (action === "choose3") {
    return "right";
  }
  return undefined;
}

function clearBranchAutoSelect(state: AppState): void {
  window.clearTimeout(state.timeoutHandle);
  state.timeoutHandle = undefined;
  state.timeoutContextKey = undefined;
  state.timeoutStartedAtMs = undefined;
  state.timeoutDurationMs = undefined;
}

function getSelectionContextKey(state: AppState): string | undefined {
  if (!state.timerStarted) {
    return undefined;
  }
  const node = getCurrentNode(state);
  if (node?.type === "decision" && state.currentNodeId) {
    return `decision:${state.currentNodeId}`;
  }
  return undefined;
}

function selectPlayerRace(state: AppState, branch: "left" | "middle" | "right"): void {
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

function activateGraphForRace(state: AppState, option: PlayerRaceOption): void {
  state.activeGraph = option.graph;
  state.selectedPlayerRace = option.playerRace;
  state.currentNodeId = option.graph.rootNodeId;
  state.currentStepIndex = 0;
  state.currentActionKey = undefined;
  state.currentActionRangeStartSeconds = undefined;
  state.timerSeconds = -COUNTDOWN_DURATION_SECONDS;
  state.timerPaused = false;
  state.timerStarted = true;
  state.currentBranchLabel = formatRaceLabel(option.playerRace);
  state.pendingDecisionChoice = undefined;
  state.rememberedDecisionChoices = {};
  state.jumpHistory = [];
  clearBranchAutoSelect(state);
  alignProgressToGameTime(state);
  render(state);
}

function chooseDecisionBranch(state: AppState, branch: "left" | "middle" | "right"): void {
  const node = getCurrentNode(state);
  if (!node || node.type !== "decision" || !state.currentNodeId) {
    debugNavigation("chooseDecisionBranch ignored; not on decision node", {
      requestedBranch: branch,
      ...getNavigationSnapshot(state)
    });
    return;
  }
  const choices = getDecisionChoices(node);
  const picked = choices.find((choice) => choice.key === branch && choice.target);
  if (!picked?.target) {
    debugNavigation("chooseDecisionBranch ignored; no target for branch", {
      nodeId: state.currentNodeId,
      requestedBranch: branch
    });
    return;
  }
  debugNavigation("chooseDecisionBranch applied", {
    nodeId: state.currentNodeId,
    requestedBranch: branch,
    targetNodeId: picked.target,
    label: picked.label
  });
  state.rememberedDecisionChoices[state.currentNodeId] = branch;
  state.currentBranchLabel = picked.label;
  state.currentNodeId = picked.target;
  state.currentStepIndex = 0;
  state.currentActionKey = undefined;
  state.currentActionRangeStartSeconds = state.timerSeconds;
  state.pendingDecisionChoice = undefined;
  clearBranchAutoSelect(state);
  alignProgressToGameTime(state);
  render(state);
}

function resetStateToStart(state: AppState): void {
  state.activeGraph = undefined;
  state.selectedPlayerRace = undefined;
  state.currentNodeId = undefined;
  state.currentStepIndex = 0;
  state.currentActionKey = undefined;
  state.currentActionRangeStartSeconds = undefined;
  state.timerSeconds = 0;
  state.timerPaused = false;
  state.timerStarted = false;
  state.currentBranchLabel = formatRaceLabel();
  state.pendingDecisionChoice = undefined;
  state.rememberedDecisionChoices = {};
  state.jumpHistory = [];
  clearBranchAutoSelect(state);
}

function isAtStartState(state: AppState): boolean {
  return (
    !state.activeGraph &&
    !state.selectedPlayerRace &&
    !state.currentNodeId &&
    state.currentStepIndex === 0 &&
    state.timerSeconds === 0 &&
    !state.timerPaused &&
    !state.timerStarted
  );
}

function alignProgressToGameTime(
  state: AppState,
  options: { useRememberedChoices?: boolean; clearIgnoredDecisionChoice?: boolean } = {}
): void {
  if (!state.activeGraph) {
    state.currentActionKey = undefined;
    state.currentActionRangeStartSeconds = undefined;
    return;
  }

  const useRememberedChoices = options.useRememberedChoices ?? true;
  const visited = new Set<string>();
  let nodeId: string | undefined = state.activeGraph.rootNodeId;
  let previousTimedAnchorSeconds = 0;
  let lastBranchLabel = formatRaceLabel(state.selectedPlayerRace);
  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node: BuildNode | undefined = state.activeGraph.nodes[nodeId];
    if (!node) {
      state.currentActionKey = undefined;
      state.currentActionRangeStartSeconds = undefined;
      return;
    }
    if (node.type === "decision") {
      const choice = getTraversalDecisionChoice(state, nodeId, node, useRememberedChoices);
      if (choice?.target) {
        lastBranchLabel = choice.label;
        nodeId = choice.target;
        continue;
      }
      if (!useRememberedChoices && options.clearIgnoredDecisionChoice) {
        delete state.rememberedDecisionChoices[nodeId];
      }
      state.currentNodeId = nodeId;
      state.currentStepIndex = 0;
      state.currentActionKey = undefined;
      state.currentActionRangeStartSeconds = previousTimedAnchorSeconds;
      state.currentBranchLabel = lastBranchLabel;
      return;
    }

    const nextIndex = node.steps.findIndex((step: { time?: string }) => {
      return stepTimeSeconds(step.time) >= state.timerSeconds;
    });
    if (nextIndex >= 0) {
      state.currentNodeId = nodeId;
      state.currentStepIndex = nextIndex;
      const currentActionKey = `${nodeId}:${nextIndex}`;
      if (state.currentActionKey !== currentActionKey) {
        let rangeStartSeconds = previousTimedAnchorSeconds;
        if (nextIndex > 0) {
          const previousStepSeconds = stepTimeSeconds(node.steps[nextIndex - 1]?.time);
          if (Number.isFinite(previousStepSeconds)) {
            rangeStartSeconds = previousStepSeconds;
          }
        }
        state.currentActionRangeStartSeconds =
          typeof rangeStartSeconds === "number" ? rangeStartSeconds : state.timerSeconds;
        state.currentActionKey = currentActionKey;
      }
      state.currentBranchLabel = lastBranchLabel;
      return;
    }

    for (let index = node.steps.length - 1; index >= 0; index -= 1) {
      const stepSeconds = stepTimeSeconds(node.steps[index]?.time);
      if (Number.isFinite(stepSeconds)) {
        previousTimedAnchorSeconds = stepSeconds;
        break;
      }
    }

    if (!node.next) {
      state.currentNodeId = nodeId;
      state.currentStepIndex = Math.max(0, node.steps.length - 1);
      const currentActionKey = `${nodeId}:${state.currentStepIndex}`;
      if (state.currentActionKey !== currentActionKey) {
        const previousStepSeconds = stepTimeSeconds(node.steps[state.currentStepIndex - 1]?.time);
        state.currentActionRangeStartSeconds = Number.isFinite(previousStepSeconds)
          ? previousStepSeconds
          : (previousTimedAnchorSeconds ?? state.timerSeconds);
        state.currentActionKey = currentActionKey;
      }
      state.currentBranchLabel = lastBranchLabel;
      return;
    }

    nodeId = node.next;
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
  let previousBuildStepSeconds = state.currentActionRangeStartSeconds ?? 0;

  if (activeNode?.type === "build" && activeStepIndex > 0) {
    const previousStep = activeNode.steps[activeStepIndex - 1];
    const previousStepSeconds = stepTimeSeconds(previousStep?.time);
    if (Number.isFinite(previousStepSeconds)) {
      previousBuildStepSeconds = previousStepSeconds;
    }
  }

  while (items.length < count) {
    const node = state.activeGraph.nodes[nodeId];
    if (!node) {
      break;
    }

    if (node.type === "build") {
      for (let index = stepIndex; index < node.steps.length && items.length < count; index += 1) {
        const step = node.steps[index];
        const stepSeconds = stepTimeSeconds(step.time);
        const secondsUntilStep = stepSeconds - state.timerSeconds;
        let elapsedProgress: number | undefined;
        if (Number.isFinite(stepSeconds) && Number.isFinite(previousBuildStepSeconds)) {
          const duration = stepSeconds - previousBuildStepSeconds;
          if (duration > 0) {
            const elapsed = state.timerSeconds - previousBuildStepSeconds;
            elapsedProgress = Math.max(0, Math.min(1, elapsed / duration));
          }
        }
        items.push({
          kind: "build",
          isCurrent: nodeId === activeNodeId && index === activeStepIndex,
          isImminent:
            Number.isFinite(stepSeconds) &&
            secondsUntilStep >= 0 &&
            secondsUntilStep <= IMMINENT_ACTION_WARNING_SECONDS,
          elapsedProgress,
          action: step.action,
          time: step.time,
          supply: step.supply
        });
        if (Number.isFinite(stepSeconds)) {
          previousBuildStepSeconds = stepSeconds;
        }
      }
      if (items.length >= count || !node.next) {
        break;
      }
      nodeId = node.next;
      stepIndex = 0;
      continue;
    }

    const choice = getTraversalDecisionChoice(state, nodeId, node, true);
    if (choice?.target) {
      nodeId = choice.target;
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
    const imminentClass = item.kind === "build" && item.isImminent ? " is-imminent" : "";
    const progressOverlay =
      typeof item.elapsedProgress === "number"
        ? `<span class="action-progress${item.kind === "selection" ? " is-selection" : ""}" style="width:${(item.elapsedProgress * 100).toFixed(3)}%"></span>`
        : "";
    if (item.kind === "build") {
      rows.push(`
        <article class="action-block${currentClass}${selectionClass}${pastDueClass}${imminentClass}">
          ${progressOverlay}
          <span class="action-text">${escapeHtml(itemText)}</span>
          <span class="action-meta">${escapeHtml(itemMeta)}</span>
        </article>
      `);
      continue;
    }

    rows.push(`
      <article class="action-block${currentClass}${selectionClass}${pastDueClass}">
        ${progressOverlay}
        <span class="action-meta">${escapeHtml(itemMeta)}</span>
        <span class="action-text">${escapeHtml(itemText)}</span>
      </article>
    `);
  }
  return rows.join("");
}

function renderSelectionRows(state: AppState, choices: DecisionChoice[]): string {
  const rows: QueueItem[] = choices.map((choice, index) => {
    let elapsedProgress: number | undefined;
    if (index === 0 && state.timeoutStartedAtMs && state.timeoutDurationMs) {
      const elapsedMs = Date.now() - state.timeoutStartedAtMs;
      elapsedProgress = Math.max(0, Math.min(1, elapsedMs / state.timeoutDurationMs));
    }
    return {
      kind: "selection",
      isCurrent: index === 0,
      elapsedProgress,
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
  const contextKey = getSelectionContextKey(state);
  if (!contextKey) {
    clearBranchAutoSelect(state);
    return;
  }

  if (state.timeoutHandle && state.timeoutContextKey === contextKey) {
    return;
  }

  clearBranchAutoSelect(state);
  state.timeoutContextKey = contextKey;
  state.timeoutStartedAtMs = Date.now();
  state.timeoutDurationMs = BRANCH_AUTO_SELECT_SECONDS * 1000;
  state.timeoutHandle = window.setTimeout(() => {
    if (state.timeoutContextKey !== contextKey) {
      return;
    }

    if (!state.timerStarted) {
      selectPlayerRace(state, "left");
      return;
    }

    const node = getCurrentNode(state);
    if (node?.type === "decision") {
      chooseDecisionBranch(state, "left");
    }
  }, state.timeoutDurationMs);
}

function render(state: AppState): void {
  const timerValue = assertElement(els.timerValue, "timer-value");
  const branchValue = assertElement(els.branchValue, "branch-value");
  const actionQueue = assertElement(els.actionQueue, "action-queue");
  const upcomingDecisions = assertElement(els.upcomingDecisions, "upcoming-decisions");
  const decisionContent = assertElement(els.decisionContent, "decision-content");
  timerValue.textContent = formatTimerDisplay(state.timerSeconds);
  branchValue.textContent = state.currentBranchLabel;
  els.setupControls?.classList.toggle("is-hidden", state.timerStarted);
  els.reloadStatus?.classList.toggle("is-hidden", state.timerStarted);
  upcomingDecisions.innerHTML = "";
  decisionContent.innerHTML = "";

  if (!state.timerStarted) {
    const choices = getPlayerRaceChoices(state);
    setActionQueueHtml(actionQueue, renderSelectionRows(state, choices));
    maybeArmDecisionTimeout(state);
    return;
  }

  const node = getCurrentNode(state);
  if (node?.type === "decision") {
    if (state.pendingDecisionChoice) {
      const choices = getDecisionChoices(node);
      const forcedChoice = choices.find(
        (choice) => choice.key === state.pendingDecisionChoice && Boolean(choice.target)
      );
      if (forcedChoice) {
        chooseDecisionBranch(state, forcedChoice.key);
        return;
      }
    }
    setActionQueueHtml(actionQueue, renderSelectionRows(state, getDecisionChoices(node)));
    maybeArmDecisionTimeout(state);
    return;
  }

  setActionQueueHtml(actionQueue, renderQueueBlocks(collectQueueItems(state, VISIBLE_QUEUE_COUNT)));
  clearBranchAutoSelect(state);
}

function advanceToNextBuildItem(state: AppState): string[] {
  if (!state.activeGraph || !state.currentNodeId) {
    debugNavigation("jumpNext aborted; no active graph or node", getNavigationSnapshot(state));
    return [];
  }
  const crossedDecisionNodeIds: string[] = [];
  const node = getCurrentNode(state);
  if (!node) {
    debugNavigation("jumpNext aborted; current node not found in graph", getNavigationSnapshot(state));
    return crossedDecisionNodeIds;
  }
  debugNavigation("jumpNext start", getNavigationSnapshot(state));

  if (node.type === "build" && state.currentStepIndex < node.steps.length - 1) {
    state.currentStepIndex += 1;
    const nextStep = node.steps[state.currentStepIndex];
    if (nextStep?.time) {
      state.timerSeconds = toSeconds(nextStep.time);
    }
    debugNavigation("jumpNext advanced within build node", {
      ...getNavigationSnapshot(state),
      nextStepAction: nextStep?.action ?? null
    });
    return crossedDecisionNodeIds;
  }

  let nextNodeId: string | undefined;
  if (node.type === "build") {
    nextNodeId = node.next;
  } else {
    const choice = getTraversalDecisionChoice(state, state.currentNodeId, node, true);
    if (!choice?.target) {
      if (node.time) {
        state.timerSeconds = toSeconds(node.time);
      }
      debugNavigation("jumpNext stopped at unresolved decision", {
        decisionNodeId: state.currentNodeId,
        ...getNavigationSnapshot(state)
      });
      return crossedDecisionNodeIds;
    }
    crossedDecisionNodeIds.push(state.currentNodeId);
    state.rememberedDecisionChoices[state.currentNodeId] = choice.key;
    state.currentBranchLabel = choice.label;
    state.pendingDecisionChoice = undefined;
    nextNodeId = choice.target;
    debugNavigation("jumpNext crossed decision", {
      decisionNodeId: state.currentNodeId,
      chosenLabel: choice.label,
      targetNodeId: choice.target
    });
  }

  const visited = new Set<string>();

  while (nextNodeId && !visited.has(nextNodeId)) {
    visited.add(nextNodeId);
    const nextNode = state.activeGraph.nodes[nextNodeId];
    if (!nextNode) {
      debugNavigation("jumpNext aborted; traversed to missing node", {
        missingNodeId: nextNodeId,
        crossedDecisionNodeIds
      });
      return crossedDecisionNodeIds;
    }

    state.currentNodeId = nextNodeId;
    state.currentStepIndex = 0;

    if (nextNode.type === "decision") {
      const choice = getTraversalDecisionChoice(state, nextNodeId, nextNode, true);
      if (choice?.target) {
        crossedDecisionNodeIds.push(nextNodeId);
        state.rememberedDecisionChoices[nextNodeId] = choice.key;
        state.currentBranchLabel = choice.label;
        state.pendingDecisionChoice = undefined;
        nextNodeId = choice.target;
        debugNavigation("jumpNext auto-traversed decision", {
          decisionNodeId: crossedDecisionNodeIds[crossedDecisionNodeIds.length - 1],
          chosenLabel: choice.label,
          targetNodeId: choice.target
        });
        continue;
      }
      if (nextNode.time) {
        state.timerSeconds = toSeconds(nextNode.time);
      }
      debugNavigation("jumpNext reached unresolved decision boundary", {
        decisionNodeId: nextNodeId,
        crossedDecisionNodeIds,
        ...getNavigationSnapshot(state)
      });
      return crossedDecisionNodeIds;
    }

    const firstStep = nextNode.steps[0];
    if (firstStep?.time) {
      state.timerSeconds = toSeconds(firstStep.time);
    }
    debugNavigation("jumpNext landed on build action", {
      crossedDecisionNodeIds,
      landedNodeId: state.currentNodeId,
      landedStepIndex: state.currentStepIndex,
      landedAction: firstStep?.action ?? null,
      timerSeconds: Number(state.timerSeconds.toFixed(3))
    });
    return crossedDecisionNodeIds;
  }
  debugNavigation("jumpNext ended due to cycle/graph termination", {
    crossedDecisionNodeIds,
    ...getNavigationSnapshot(state)
  });
  return crossedDecisionNodeIds;
}

function jumpBySeconds(state: AppState, deltaSeconds: number): void {
  const minimum = state.timerStarted ? -COUNTDOWN_DURATION_SECONDS : 0;
  state.timerSeconds = Math.max(minimum, state.timerSeconds + deltaSeconds);
  alignProgressToGameTime(state);
  render(state);
}

function jumpToPreviousBuildItem(state: AppState): void {
  debugNavigation("jumpPrevious start", getNavigationSnapshot(state));
  const previous = state.jumpHistory.pop();
  if (!previous) {
    debugNavigation("jumpPrevious no-op; history empty", getNavigationSnapshot(state));
    return;
  }
  state.currentNodeId = previous.nodeId;
  state.currentStepIndex = previous.stepIndex;
  state.timerSeconds = previous.timerSeconds;
  state.currentBranchLabel = previous.currentBranchLabel;
  state.pendingDecisionChoice = previous.pendingDecisionChoice;
  state.rememberedDecisionChoices = { ...previous.rememberedDecisionChoices };
  const crossedDecisionNodeIds = previous.crossedDecisionNodeIds ?? [];
  const decisionNodeIdsToClearOnUndo = previous.decisionNodeIdsToClearOnUndo ?? [];
  for (const decisionNodeId of previous.decisionNodeIdsToClearOnUndo ?? []) {
    delete state.rememberedDecisionChoices[decisionNodeId];
  }
  if (crossedDecisionNodeIds.length > 0 || decisionNodeIdsToClearOnUndo.length > 0) {
    state.pendingDecisionChoice = undefined;
  }
  alignProgressToGameTime(state);
  debugNavigation("jumpPrevious restored history entry", {
    restoredNodeId: previous.nodeId,
    restoredStepIndex: previous.stepIndex,
    restoredTimerSeconds: previous.timerSeconds,
    crossedDecisionNodeIds,
    decisionNodeIdsToClearOnUndo,
    ...getNavigationSnapshot(state)
  });
}

function jumpToNextBuildItem(state: AppState): void {
  if (!state.currentNodeId) {
    debugNavigation("jumpNext no-op; current node undefined", getNavigationSnapshot(state));
    return;
  }
  debugNavigation("jumpNext preparing history entry", getNavigationSnapshot(state));
  const historyEntry: JumpHistoryEntry = {
    nodeId: state.currentNodeId,
    stepIndex: state.currentStepIndex,
    timerSeconds: state.timerSeconds,
    currentBranchLabel: state.currentBranchLabel,
    pendingDecisionChoice: state.pendingDecisionChoice,
    rememberedDecisionChoices: { ...state.rememberedDecisionChoices }
  };
  const crossedDecisionNodeIds = advanceToNextBuildItem(state);
  if (crossedDecisionNodeIds.length > 0) {
    historyEntry.crossedDecisionNodeIds = crossedDecisionNodeIds;
    const decisionNodeIdsToClearOnUndo = crossedDecisionNodeIds.filter(
      (decisionNodeId) => !(decisionNodeId in historyEntry.rememberedDecisionChoices)
    );
    if (decisionNodeIdsToClearOnUndo.length > 0) {
      historyEntry.decisionNodeIdsToClearOnUndo = decisionNodeIdsToClearOnUndo;
    }
  }
  state.jumpHistory.push(historyEntry);
  debugNavigation("jumpNext completed and history pushed", {
    crossedDecisionNodeIds,
    decisionNodeIdsToClearOnUndo: historyEntry.decisionNodeIdsToClearOnUndo ?? [],
    historyDepthAfterPush: state.jumpHistory.length,
    ...getNavigationSnapshot(state)
  });
}

function handleAction(state: AppState, action: ControlAction): void {
  const node = getCurrentNode(state);
  const chooseBranch = getBranchForChooseAction(action);

  if (action === "reset") {
    resetStateToStart(state);
    render(state);
    void (async () => {
      const isVisible = await window.overlayApi.isOverlayVisible();
      if (isVisible) {
        await window.overlayApi.hideOverlay();
        return;
      }
      await window.overlayApi.showOverlay();
    })();
    return;
  }

  if (!state.timerStarted) {
    if (chooseBranch) {
      selectPlayerRace(state, chooseBranch);
    }
    return;
  }

  if (action === "jumpBackward" || action === "jumpForward") {
    jumpBySeconds(state, action === "jumpBackward" ? -COUNTDOWN_JUMP_SECONDS : COUNTDOWN_JUMP_SECONDS);
    return;
  }

  if (action === "pause") {
    state.timerPaused = !state.timerPaused;
    render(state);
    return;
  }

  if (action === "jumpNext") {
    debugNavigation("handleAction jumpNext", getNavigationSnapshot(state));
    jumpToNextBuildItem(state);
    render(state);
    return;
  }

  if (action === "jumpPrevious") {
    debugNavigation("handleAction jumpPrevious", getNavigationSnapshot(state));
    jumpToPreviousBuildItem(state);
    render(state);
    return;
  }

  if (chooseBranch) {
    if (node?.type === "decision") {
      chooseDecisionBranch(state, chooseBranch);
      return;
    }
    state.pendingDecisionChoice = chooseBranch;
    render(state);
    return;
  }
}

function setupFocusedFallback(state: AppState): void {
  window.addEventListener("keydown", (event) => {
    const focusedHotkeys = state.data.config.hotkeys.focused;
    const pressedKey = event.code.toLowerCase();
    const pressedValue = event.key.toLowerCase();
    const toggleVisibilityHotkey = focusedHotkeys.toggleVisibility?.toLowerCase();
    if (
      toggleVisibilityHotkey &&
      (pressedKey === toggleVisibilityHotkey || pressedValue === toggleVisibilityHotkey)
    ) {
      event.preventDefault();
      void window.overlayApi.toggleOverlayVisibility();
      return;
    }
    const actionByKey = new Map<string, ControlAction>([
      [focusedHotkeys.choose1.toLowerCase(), "choose1"],
      [focusedHotkeys.choose2.toLowerCase(), "choose2"],
      [focusedHotkeys.choose3.toLowerCase(), "choose3"],
      [focusedHotkeys.reset.toLowerCase(), "reset"],
      [focusedHotkeys.jumpForward.toLowerCase(), "jumpForward"],
      [focusedHotkeys.jumpBackward.toLowerCase(), "jumpBackward"],
      [focusedHotkeys.jumpPrevious.toLowerCase(), "jumpPrevious"],
      [focusedHotkeys.jumpNext.toLowerCase(), "jumpNext"]
    ]);
    if (focusedHotkeys.pause) {
      actionByKey.set(focusedHotkeys.pause.toLowerCase(), "pause");
    }
    const action = actionByKey.get(pressedKey) ?? actionByKey.get(pressedValue);
    if (!action) {
      return;
    }
    event.preventDefault();
    handleAction(state, action);
  });
}

function applyReloadedData(state: AppState, data: InitialAppData): void {
  const previousPlayerRace = state.selectedPlayerRace;
  const previousTimerSeconds = state.timerSeconds;
  const previousTimerPaused = state.timerPaused;
  const hadStarted = state.timerStarted;

  state.data = data;
  applyUiScale(data.config.ui.fontScale, data.config.ui.scale);

  if (hadStarted) {
    const nextOption =
      data.raceOptions.find((option) => option.playerRace === previousPlayerRace) ?? data.raceOptions[0];
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
  state.selectedPlayerRace = undefined;
  state.currentNodeId = undefined;
  state.currentStepIndex = 0;
  state.currentActionKey = undefined;
  state.currentActionRangeStartSeconds = undefined;
  state.timerSeconds = 0;
  state.timerPaused = false;
  state.timerStarted = false;
  state.currentBranchLabel = formatRaceLabel();
  state.pendingDecisionChoice = undefined;
  state.rememberedDecisionChoices = {};
  state.jumpHistory = [];
  clearBranchAutoSelect(state);
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
    if (!state.timerStarted) return;
    if (!state.timerPaused) {
      state.timerSeconds += TICK_INTERVAL_MS / 1000;
      alignProgressToGameTime(state);
      render(state);
    }
  }, TICK_INTERVAL_MS);
}

async function main(): Promise<void> {
  const data = await window.overlayApi.getInitialData();
  applyUiScale(data.config.ui.fontScale, data.config.ui.scale);

  const state: AppState = {
    data,
    currentStepIndex: 0,
    currentActionKey: undefined,
    currentActionRangeStartSeconds: undefined,
    timerSeconds: 0,
    timerPaused: false,
    timerStarted: false,
    currentBranchLabel: formatRaceLabel(),
    rememberedDecisionChoices: {},
    jumpHistory: []
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
