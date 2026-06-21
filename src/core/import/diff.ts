import type { CompactBranchEntry, CompactBuildFile, CompactBuildStep } from "../types";
import type { MergeDiff, MergeStepDiff } from "./types";

function branchStepLines(branch: CompactBranchEntry): string[] {
  if (branch.target) {
    return [`-> ${branch.target}`];
  }
  const lines: string[] = [];
  for (const step of branch.steps ?? []) {
    lines.push(formatStep(step));
  }
  return lines;
}

function formatStep(step: CompactBuildStep): string {
  if (step.decision) {
    const opts = (["1", "2", "3"] as const)
      .map((slot) => step.decision?.[slot])
      .filter((value): value is { label: string; target: string } => Boolean(value))
      .map((value) => `${value.label} -> ${value.target}`);
    const time = step.time ? `${step.time} ` : "";
    return `${time}decision { ${opts.join(" | ")} }`;
  }
  const segments: string[] = [];
  if (step.time) {
    segments.push(step.time);
  }
  if (typeof step.supply === "number") {
    segments.push(String(step.supply));
  }
  const prefix = segments.length > 0 ? `${segments.join(" | ")} | ` : "";
  return `${prefix}${step.action ?? ""}`;
}

export function computeMergeDiff(original: CompactBuildFile, patched: CompactBuildFile): MergeDiff {
  const addedBranches: string[] = [];
  const modifiedBranches: string[] = [];
  const steps: MergeStepDiff[] = [];

  for (const branchId of Object.keys(patched)) {
    const before = original[branchId];
    const after = patched[branchId];
    if (!before) {
      addedBranches.push(branchId);
      for (const line of branchStepLines(after)) {
        steps.push({ kind: "added", branchId, text: line });
      }
      continue;
    }
    const beforeLines = branchStepLines(before);
    const afterLines = branchStepLines(after);
    if (beforeLines.join("\n") !== afterLines.join("\n")) {
      modifiedBranches.push(branchId);
      const beforeSet = new Set(beforeLines);
      for (const line of afterLines) {
        steps.push({ kind: beforeSet.has(line) ? "context" : "added", branchId, text: line });
      }
    }
  }

  return { addedBranches, modifiedBranches, steps };
}

export function renderMergeDiff(diff: MergeDiff): string {
  const lines: string[] = [];
  if (diff.addedBranches.length > 0) {
    lines.push(`Added branches: ${diff.addedBranches.join(", ")}`);
  }
  if (diff.modifiedBranches.length > 0) {
    lines.push(`Modified branches: ${diff.modifiedBranches.join(", ")}`);
  }
  lines.push("");
  let currentBranch = "";
  for (const step of diff.steps) {
    if (step.branchId !== currentBranch) {
      currentBranch = step.branchId;
      lines.push(`[${currentBranch}]`);
    }
    const marker = step.kind === "added" ? "+" : " ";
    lines.push(`  ${marker} ${step.text}`);
  }
  return lines.join("\n");
}
