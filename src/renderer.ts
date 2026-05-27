import type {
  AppConfig,
  BuildNode,
  ControlAction,
  DecisionNodeEntry,
  InitialAppData,
  PlayerRace,
  PlayerRaceOption,
  ResolvedBuildGraph
} from "./core/types";

const DEFAULT_VISIBLE_QUEUE_COUNT = 5;
let BRANCH_AUTO_SELECT_SECONDS = 8;
let ENTRY_GRACE_SECONDS = 8;
const IMMINENT_ACTION_WARNING_SECONDS = 5;
const COUNTDOWN_DURATION_SECONDS = 3;
const COUNTDOWN_JUMP_SECONDS = 5;
const TICK_INTERVAL_MS = 100;
const DECISION_INPUT_BUFFER_MS = 350;
const ACTION_SELECTION_EPSILON_SECONDS = 0.001;
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
  pendingDecisionQueue: DecisionChoice["key"][];
  decisionInputBlockedUntilMs?: number;
  lastQueuedChooseBranch?: DecisionChoice["key"];
  lastQueuedChooseAtMs?: number;
  rememberedDecisionChoices: Record<string, DecisionChoice["key"]>;
  jumpHistory: JumpHistoryEntry[];
  debugInputSequence: number;
  lastActionAtMsBySource: Partial<Record<string, number>>;
}

interface JumpHistoryEntry {
  nodeId: string;
  stepIndex: number;
  timerSeconds: number;
  currentBranchLabel: string;
  pendingDecisionQueue: DecisionChoice["key"][];
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

interface ResolvedBuildStepRef {
  nodeId: string;
  stepIndex: number;
  timeSeconds: number;
}

const els = {
  timerValue: document.querySelector<HTMLElement>("#timer-value"),
  branchValue: document.querySelector<HTMLElement>("#branch-value"),
  actionQueue: document.querySelector<HTMLElement>("#action-queue"),
  upcomingDecisions: document.querySelector<HTMLElement>("#upcoming-decisions"),
  decisionContent: document.querySelector<HTMLElement>("#decision-content"),
  overlayPanel: document.querySelector<HTMLElement>(".overlay-panel")
};

let pendingOverlayResizeFrame = 0;
let lastRequestedOverlayHeight = -1;

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

function applyUiScale(fontScale: number, scale: number): void {
  const normalizedFontScale = Number.isFinite(fontScale) ? Math.max(0.1, fontScale) : 1;
  const normalizedScale = Number.isFinite(scale) ? Math.max(0.1, scale) : 1;
  document.documentElement.style.fontSize = `${normalizedFontScale}rem`;

  const panel = assertElement(els.overlayPanel, "overlay-panel");
  panel.style.transformOrigin = "top left";
  panel.style.transform = `scale(${normalizedScale})`;
}

function getVisibleQueueCount(state: AppState): number {
  const configured = state.data.config.ui.showNextCount;
  if (!Number.isFinite(configured)) {
    return DEFAULT_VISIBLE_QUEUE_COUNT;
  }
  return Math.max(0, Math.floor(configured));
}

function requestOverlayResize(): void {
  if (pendingOverlayResizeFrame) {
    return;
  }
  pendingOverlayResizeFrame = window.requestAnimationFrame(() => {
    pendingOverlayResizeFrame = 0;
    const panel = els.overlayPanel;
    if (!panel) {
      return;
    }
    const nextHeight = Math.max(1, Math.ceil(panel.getBoundingClientRect().height + 2));
    if (nextHeight === lastRequestedOverlayHeight) {
      return;
    }
    lastRequestedOverlayHeight = nextHeight;
    const overlayApi = window.overlayApi as typeof window.overlayApi & {
      resizeOverlay: (height: number) => Promise<void>;
    };
    void overlayApi.resizeOverlay(nextHeight);
  });
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

function nextDebugInputSequence(state: AppState): number {
  state.debugInputSequence += 1;
  return state.debugInputSequence;
}

function getNavigationSnapshot(state: AppState): Record<string, unknown> {
  const node = getCurrentNode(state);
  return {
    nodeId: state.currentNodeId,
    nodeType: node?.type ?? "none",
    stepIndex: state.currentStepIndex,
    timerSeconds: Number(state.timerSeconds.toFixed(3)),
    branchLabel: state.currentBranchLabel,
    pendingDecisionChoice: state.pendingDecisionQueue[0] ?? null,
    pendingDecisionQueue: [...state.pendingDecisionQueue],
    rememberedDecisionChoices: { ...state.rememberedDecisionChoices },
    jumpHistoryDepth: state.jumpHistory.length
  };
}

function getPendingDecisionChoice(state: AppState): DecisionChoice["key"] | undefined {
  return state.pendingDecisionQueue[0];
}

function enqueuePendingDecisionChoice(state: AppState, branch: DecisionChoice["key"]): void {
  state.pendingDecisionQueue.push(branch);
}

function consumePendingDecisionChoice(state: AppState): DecisionChoice["key"] | undefined {
  return state.pendingDecisionQueue.shift();
}

function clearPendingDecisionQueue(state: AppState): void {
  state.pendingDecisionQueue = [];
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

function describeDecisionChoices(node: DecisionNodeEntry): Array<Record<string, unknown>> {
  return getDecisionChoices(node).map((choice) => ({
    key: choice.key,
    label: choice.label,
    target: choice.target ?? null
  }));
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

function getFarthestResolvedBranchLabel(state: AppState): string {
  if (!state.activeGraph) {
    return formatRaceLabel(state.selectedPlayerRace);
  }

  const visited = new Set<string>();
  let nodeId: string | undefined = state.activeGraph.rootNodeId;
  let lastResolvedLabel = formatRaceLabel(state.selectedPlayerRace);

  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node: BuildNode | undefined = state.activeGraph.nodes[nodeId];
    if (!node) {
      break;
    }

    if (node.type === "decision") {
      const rememberedChoice = getRememberedDecisionChoice(state, nodeId, node);
      if (!rememberedChoice?.target) {
        break;
      }
      lastResolvedLabel = rememberedChoice.label;
      nodeId = rememberedChoice.target;
      continue;
    }

    nodeId = node.next;
  }

  return lastResolvedLabel;
}

function getResolvedBuildTimeline(state: AppState): ResolvedBuildStepRef[] {
  if (!state.activeGraph) {
    return [];
  }

  const visited = new Set<string>();
  const timeline: ResolvedBuildStepRef[] = [];
  let nodeId: string | undefined = state.activeGraph.rootNodeId;

  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node: BuildNode | undefined = state.activeGraph.nodes[nodeId];
    if (!node) {
      break;
    }

    if (node.type === "decision") {
      const rememberedChoice = getRememberedDecisionChoice(state, nodeId, node);
      if (!rememberedChoice?.target) {
        break;
      }
      nodeId = rememberedChoice.target;
      continue;
    }

    for (let stepIndex = 0; stepIndex < node.steps.length; stepIndex += 1) {
      timeline.push({
        nodeId,
        stepIndex,
        timeSeconds: stepTimeSeconds(node.steps[stepIndex]?.time)
      });
    }
    nodeId = node.next;
  }

  return timeline;
}

function getTraversalDecisionChoice(
  state: AppState,
  nodeId: string,
  node: DecisionNodeEntry,
  useRememberedChoices: boolean,
  allowPendingChoice = true
): { choice?: DecisionChoice; source: "pending" | "remembered" | "none" } {
  void allowPendingChoice;
  if (!useRememberedChoices) {
    return { source: "none" };
  }
  const rememberedChoice = getRememberedDecisionChoice(state, nodeId, node);
  if (rememberedChoice) {
    debugNavigation("getTraversalDecisionChoice using remembered decision choice", {
      nodeId,
      rememberedKey: rememberedChoice.key,
      rememberedLabel: rememberedChoice.label,
      rememberedTarget: rememberedChoice.target
    });
    return { choice: rememberedChoice, source: "remembered" };
  }
  return { source: "none" };
}

function findNextUnresolvedDecisionNode(
  state: AppState
): { nodeId: string; node: DecisionNodeEntry } | undefined {
  if (!state.activeGraph || !state.currentNodeId) {
    return undefined;
  }

  const visited = new Set<string>();
  let nodeId: string | undefined = state.currentNodeId;
  let skipCurrentBuildNode = true;

  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node: BuildNode | undefined = state.activeGraph.nodes[nodeId];
    if (!node) {
      return undefined;
    }

    if (node.type === "decision") {
      const rememberedChoice = getRememberedDecisionChoice(state, nodeId, node);
      if (!rememberedChoice?.target) {
        return { nodeId, node };
      }
      nodeId = rememberedChoice.target;
      skipCurrentBuildNode = false;
      continue;
    }

    if (skipCurrentBuildNode) {
      nodeId = node.next;
      skipCurrentBuildNode = false;
      continue;
    }

    nodeId = node.next;
  }

  return undefined;
}

function resolveUpcomingDecisionChoice(
  state: AppState,
  branch: DecisionChoice["key"],
  source: string,
  inputSeq: number
): boolean {
  const upcomingDecision = findNextUnresolvedDecisionNode(state);
  if (!upcomingDecision) {
    debugNavigation("resolveUpcomingDecisionChoice ignored; no unresolved future decision", {
      inputSeq,
      source,
      requestedBranch: branch,
      ...getNavigationSnapshot(state)
    });
    return false;
  }

  const picked = getDecisionChoices(upcomingDecision.node).find(
    (choice) => choice.key === branch && Boolean(choice.target)
  );
  if (!picked?.target) {
    debugNavigation("resolveUpcomingDecisionChoice ignored; branch invalid for upcoming decision", {
      inputSeq,
      source,
      requestedBranch: branch,
      decisionNodeId: upcomingDecision.nodeId,
      choices: describeDecisionChoices(upcomingDecision.node)
    });
    return false;
  }

  state.rememberedDecisionChoices[upcomingDecision.nodeId] = branch;
  state.decisionInputBlockedUntilMs = Date.now() + DECISION_INPUT_BUFFER_MS;
  debugNavigation("resolveUpcomingDecisionChoice applied immediately", {
    inputSeq,
    source,
    requestedBranch: branch,
    decisionNodeId: upcomingDecision.nodeId,
    chosenLabel: picked.label,
    chosenTarget: picked.target,
    blockedUntilMs: state.decisionInputBlockedUntilMs,
    rememberedAfter: { ...state.rememberedDecisionChoices }
  });
  alignProgressToGameTime(state);
  render(state);
  return true;
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
  clearPendingDecisionQueue(state);
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
    label: picked.label,
    rememberedBefore: { ...state.rememberedDecisionChoices },
    pendingBefore: getPendingDecisionChoice(state) ?? null,
    pendingQueueBefore: [...state.pendingDecisionQueue]
  });
  state.rememberedDecisionChoices[state.currentNodeId] = branch;
  state.currentBranchLabel = picked.label;
  state.currentNodeId = picked.target;
  state.currentStepIndex = 0;
  state.currentActionKey = undefined;
  state.currentActionRangeStartSeconds = state.timerSeconds;
  state.decisionInputBlockedUntilMs = Date.now() + DECISION_INPUT_BUFFER_MS;
  debugNavigation("chooseDecisionBranch state updated", {
    newNodeId: state.currentNodeId,
    blockedUntilMs: state.decisionInputBlockedUntilMs,
    rememberedAfter: { ...state.rememberedDecisionChoices },
    pendingAfter: getPendingDecisionChoice(state) ?? null,
    pendingQueueAfter: [...state.pendingDecisionQueue]
  });
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
  clearPendingDecisionQueue(state);
  state.decisionInputBlockedUntilMs = undefined;
  state.lastQueuedChooseBranch = undefined;
  state.lastQueuedChooseAtMs = undefined;
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
  let allowPendingChoiceForTraversal = true;
  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node: BuildNode | undefined = state.activeGraph.nodes[nodeId];
    if (!node) {
      state.currentActionKey = undefined;
      state.currentActionRangeStartSeconds = undefined;
      return;
    }
    if (node.type === "decision") {
      const resolution = getTraversalDecisionChoice(
        state,
        nodeId,
        node,
        useRememberedChoices,
        allowPendingChoiceForTraversal
      );
      const choice = resolution.choice;
      if (choice?.target) {
        if (resolution.source === "pending") {
          // A queued choose input should only affect one decision boundary.
          // Persist it as a remembered choice on that node, then consume it.
          state.rememberedDecisionChoices[nodeId] = choice.key;
          consumePendingDecisionChoice(state);
          allowPendingChoiceForTraversal = false;
          debugNavigation("alignProgressToGameTime consumed pending decision choice", {
            nodeId,
            consumedKey: choice.key,
            consumedLabel: choice.label,
            consumedTarget: choice.target,
            pendingQueueAfterConsume: [...state.pendingDecisionQueue]
          });
        }
        lastBranchLabel = choice.label;
        debugNavigation("alignProgressToGameTime traversing decision node", {
          nodeId,
          chosenKey: choice.key,
          chosenLabel: choice.label,
          chosenTarget: choice.target,
          choiceSource: resolution.source,
          pendingDecisionChoice: getPendingDecisionChoice(state) ?? null,
          pendingDecisionQueue: [...state.pendingDecisionQueue],
          useRememberedChoices
        });
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
      debugNavigation("alignProgressToGameTime stopped at unresolved decision", {
        nodeId,
        useRememberedChoices,
        pendingDecisionChoice: getPendingDecisionChoice(state) ?? null,
        pendingDecisionQueue: [...state.pendingDecisionQueue],
        rememberedDecisionChoices: { ...state.rememberedDecisionChoices },
        choices: describeDecisionChoices(node)
      });
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
  let allowPendingChoiceForTraversal = true;

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

    const resolvedChoice = getTraversalDecisionChoice(
      state,
      nodeId,
      node,
      true,
      allowPendingChoiceForTraversal
    );
    if (resolvedChoice.source === "pending") {
      allowPendingChoiceForTraversal = false;
    }
    if (resolvedChoice.choice?.target) {
      nodeId = resolvedChoice.choice.target;
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

function renderQueueBlocks(queueItems: QueueItem[], visibleCount: number): string {
  const rows: string[] = [];
  for (let index = 0; index < visibleCount; index += 1) {
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
  return renderQueueBlocks(rows, getVisibleQueueCount(state));
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
  const visibleQueueCount = getVisibleQueueCount(state);
  state.currentBranchLabel = getFarthestResolvedBranchLabel(state);
  timerValue.textContent = formatTimerDisplay(state.timerSeconds);
  branchValue.textContent = state.currentBranchLabel;
  upcomingDecisions.innerHTML = "";
  decisionContent.innerHTML = "";

  if (!state.timerStarted) {
    const choices = getPlayerRaceChoices(state);
    setActionQueueHtml(actionQueue, renderSelectionRows(state, choices));
    maybeArmDecisionTimeout(state);
    requestOverlayResize();
    return;
  }

  const node = getCurrentNode(state);
  if (node?.type === "decision") {
    setActionQueueHtml(actionQueue, renderSelectionRows(state, getDecisionChoices(node)));
    maybeArmDecisionTimeout(state);
    requestOverlayResize();
    return;
  }

  setActionQueueHtml(actionQueue, renderQueueBlocks(collectQueueItems(state, visibleQueueCount), visibleQueueCount));
  clearBranchAutoSelect(state);
  requestOverlayResize();
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
    const resolution = getTraversalDecisionChoice(state, state.currentNodeId, node, true, true);
    const choice = resolution.choice;
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
    nextNodeId = choice.target;
    debugNavigation("jumpNext crossed decision", {
      decisionNodeId: state.currentNodeId,
      chosenLabel: choice.label,
      targetNodeId: choice.target,
      choiceSource: resolution.source
    });
  }

  const visited = new Set<string>();
  let allowPendingChoiceForTraversal = true;

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
      const resolution = getTraversalDecisionChoice(
        state,
        nextNodeId,
        nextNode,
        true,
        allowPendingChoiceForTraversal
      );
      const choice = resolution.choice;
      if (resolution.source === "pending") {
        allowPendingChoiceForTraversal = false;
      }
      if (choice?.target) {
        crossedDecisionNodeIds.push(nextNodeId);
        state.rememberedDecisionChoices[nextNodeId] = choice.key;
        state.currentBranchLabel = choice.label;
        nextNodeId = choice.target;
        debugNavigation("jumpNext auto-traversed decision", {
          decisionNodeId: crossedDecisionNodeIds[crossedDecisionNodeIds.length - 1],
          chosenLabel: choice.label,
          targetNodeId: choice.target,
          choiceSource: resolution.source
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
  const timeline = getResolvedBuildTimeline(state);
  if (timeline.length === 0) {
    debugNavigation("jumpPrevious no-op; resolved timeline empty", getNavigationSnapshot(state));
    return;
  }

  let targetIndex = timeline.findIndex(
    (entry) => entry.nodeId === state.currentNodeId && entry.stepIndex === state.currentStepIndex
  );
  if (targetIndex >= 0) {
    targetIndex -= 1;
  } else {
    targetIndex = -1;
    for (let index = 0; index < timeline.length; index += 1) {
      if (timeline[index].timeSeconds < state.timerSeconds) {
        targetIndex = index;
        continue;
      }
      break;
    }
  }

  if (targetIndex < 0) {
    debugNavigation("jumpPrevious no-op; already at earliest resolved build item", {
      ...getNavigationSnapshot(state),
      timelineLength: timeline.length
    });
    return;
  }

  const target = timeline[targetIndex];
  state.timerSeconds = Number.isFinite(target.timeSeconds)
    ? Math.max(-COUNTDOWN_DURATION_SECONDS, target.timeSeconds - ACTION_SELECTION_EPSILON_SECONDS)
    : state.timerSeconds;
  state.currentNodeId = target.nodeId;
  state.currentStepIndex = target.stepIndex;
  state.currentActionKey = undefined;
  state.currentActionRangeStartSeconds = undefined;
  clearPendingDecisionQueue(state);
  alignProgressToGameTime(state);
  render(state);
  debugNavigation("jumpPrevious moved to resolved build item", {
    targetNodeId: target.nodeId,
    targetStepIndex: target.stepIndex,
    targetTimerSeconds: target.timeSeconds,
    appliedTimerSeconds: state.timerSeconds,
    ...getNavigationSnapshot(state)
  });
}

function jumpToNextBuildItem(state: AppState): void {
  if (!state.currentNodeId) {
    debugNavigation("jumpNext no-op; current node undefined", getNavigationSnapshot(state));
    return;
  }
  debugNavigation("jumpNext start", getNavigationSnapshot(state));
  const timeline = getResolvedBuildTimeline(state);
  if (timeline.length === 0) {
    debugNavigation("jumpNext no-op; resolved timeline empty", getNavigationSnapshot(state));
    return;
  }

  let targetIndex = timeline.findIndex(
    (entry) => entry.nodeId === state.currentNodeId && entry.stepIndex === state.currentStepIndex
  );
  if (targetIndex >= 0) {
    targetIndex += 1;
  } else {
    targetIndex = timeline.findIndex((entry) => entry.timeSeconds > state.timerSeconds);
  }

  if (targetIndex < 0 || targetIndex >= timeline.length) {
    debugNavigation("jumpNext no-op; already at latest resolved build item", {
      ...getNavigationSnapshot(state),
      timelineLength: timeline.length
    });
    return;
  }

  const target = timeline[targetIndex];
  state.timerSeconds = Number.isFinite(target.timeSeconds)
    ? Math.max(-COUNTDOWN_DURATION_SECONDS, target.timeSeconds - ACTION_SELECTION_EPSILON_SECONDS)
    : state.timerSeconds;
  state.currentNodeId = target.nodeId;
  state.currentStepIndex = target.stepIndex;
  state.currentActionKey = undefined;
  state.currentActionRangeStartSeconds = undefined;
  clearPendingDecisionQueue(state);
  alignProgressToGameTime(state);
  render(state);
  debugNavigation("jumpNext moved to resolved build item", {
    targetNodeId: target.nodeId,
    targetStepIndex: target.stepIndex,
    targetTimerSeconds: target.timeSeconds,
    appliedTimerSeconds: state.timerSeconds,
    ...getNavigationSnapshot(state)
  });
}

function handleAction(state: AppState, action: ControlAction, source = "unknown"): void {
  const node = getCurrentNode(state);
  const chooseBranch = getBranchForChooseAction(action);
  const inputSeq = nextDebugInputSequence(state);
  const now = Date.now();
  const lastAtForSource = state.lastActionAtMsBySource[source];
  const deltaMsFromSameSource = typeof lastAtForSource === "number" ? now - lastAtForSource : null;
  state.lastActionAtMsBySource[source] = now;
  debugNavigation("handleAction received", {
    inputSeq,
    source,
    deltaMsFromSameSource,
    action,
    chooseBranch: chooseBranch ?? null,
    timerStarted: state.timerStarted,
    currentNodeId: state.currentNodeId ?? null,
    currentNodeType: node?.type ?? null,
    currentDecisionChoices:
      node?.type === "decision" ? describeDecisionChoices(node) : null,
    pendingDecisionChoice: getPendingDecisionChoice(state) ?? null,
    pendingDecisionQueue: [...state.pendingDecisionQueue],
    decisionInputBlockedUntilMs: state.decisionInputBlockedUntilMs ?? null,
    nowMs: now
  });

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
      debugNavigation("handleAction selecting race", {
        inputSeq,
        source,
        chooseBranch
      });
      selectPlayerRace(state, chooseBranch);
      state.decisionInputBlockedUntilMs = Date.now() + DECISION_INPUT_BUFFER_MS;
      debugNavigation("handleAction race selected and buffered", {
        inputSeq,
        blockedUntilMs: state.decisionInputBlockedUntilMs
      });
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
    if (typeof state.decisionInputBlockedUntilMs === "number" && now < state.decisionInputBlockedUntilMs) {
      debugNavigation("choose action ignored due to decision input buffer", {
        inputSeq,
        source,
        requestedBranch: chooseBranch,
        blockedUntilMs: state.decisionInputBlockedUntilMs,
        nowMs: now,
        ...getNavigationSnapshot(state)
      });
      return;
    }
    if (node?.type === "decision") {
      debugNavigation("handleAction applying choose on current decision node", {
        inputSeq,
        source,
        nodeId: state.currentNodeId,
        requestedBranch: chooseBranch,
        choices: describeDecisionChoices(node)
      });
      chooseDecisionBranch(state, chooseBranch);
      return;
    }
    resolveUpcomingDecisionChoice(state, chooseBranch, source, inputSeq);
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
    debugNavigation("focused keydown mapped to action", {
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      action,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey
    });
    event.preventDefault();
    handleAction(state, action, "focused-keydown");
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

function applyTimerConfig(config: AppConfig["timer"]): void {
  if (typeof config.decisionTimeoutSeconds === "number") {
    BRANCH_AUTO_SELECT_SECONDS = config.decisionTimeoutSeconds;
  }
  if (typeof config.entryGraceSeconds === "number") {
    ENTRY_GRACE_SECONDS = config.entryGraceSeconds;
  }
}

async function main(): Promise<void> {
  const data = await window.overlayApi.getInitialData();
  applyUiScale(data.config.ui.fontScale, data.config.ui.scale);
  applyTimerConfig(data.config.timer);

  const state: AppState = {
    data,
    currentStepIndex: 0,
    currentActionKey: undefined,
    currentActionRangeStartSeconds: undefined,
    timerSeconds: 0,
    timerPaused: false,
    timerStarted: false,
    currentBranchLabel: formatRaceLabel(),
    pendingDecisionQueue: [],
    decisionInputBlockedUntilMs: undefined,
    lastQueuedChooseBranch: undefined,
    lastQueuedChooseAtMs: undefined,
    rememberedDecisionChoices: {},
    jumpHistory: [],
    debugInputSequence: 0,
    lastActionAtMsBySource: {}
  };

  render(state);
  setupFocusedFallback(state);
  startTickLoop(state);
  window.overlayApi.onControlAction((action) => {
    debugNavigation("overlay control action received", { action });
    handleAction(state, action, "overlay-control");
  });
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
