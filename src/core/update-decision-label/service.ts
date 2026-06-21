import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateCompactBuild } from "../loader";
import type { CompactBuildFile, OpponentRace } from "../types";
import type { UpdateDecisionLabelRequest, UpdateDecisionLabelResponse } from "./types";

function targetPathFor(buildsPath: string, buildId: string): string {
  const relative = buildId.split(".").join(path.sep);
  return path.resolve(buildsPath, `${relative}.json`);
}

function discoverRace(compact: CompactBuildFile): OpponentRace | null {
  if (compact.zerg) {
    return "zerg";
  }
  if (compact.terran) {
    return "terran";
  }
  if (compact.protoss) {
    return "protoss";
  }
  return null;
}

/**
 * Environment-agnostic decision-label persistence. Reads the target compact
 * file, updates a decision branch label, validates, and writes it back.
 * Shared by the vite dev middleware and Electron IPC.
 */
export function updateDecisionLabel(
  buildsPath: string,
  req: UpdateDecisionLabelRequest
): UpdateDecisionLabelResponse {
  try {
    if (!req?.buildId) {
      return { ok: false, error: "Missing target build id." };
    }
    if (!req?.branchId) {
      return { ok: false, error: "Missing branch id." };
    }
    if (!req?.slot || !["1", "2", "3"].includes(req.slot)) {
      return { ok: false, error: "Missing or invalid decision slot." };
    }

    const label = req.label?.trim() ?? "";
    if (label.length === 0) {
      return { ok: false, error: "Label cannot be empty." };
    }

    const targetPath = targetPathFor(buildsPath, req.buildId);
    const compact = JSON.parse(readFileSync(targetPath, "utf8")) as CompactBuildFile;

    const entry = compact[req.branchId];
    if (!entry?.steps?.length) {
      return { ok: false, error: `Branch "${req.branchId}" not found or has no steps.` };
    }

    const decisionStep = entry.steps[entry.steps.length - 1];
    if (!decisionStep?.decision) {
      return { ok: false, error: `Branch "${req.branchId}" has no decision step.` };
    }

    const branch = decisionStep.decision[req.slot];
    if (!branch) {
      return { ok: false, error: `Decision slot "${req.slot}" not found on branch "${req.branchId}".` };
    }

    branch.label = label;

    const race = discoverRace(compact);
    const validation = validateCompactBuild(compact, {
      buildId: req.buildId,
      rootBranchId: race ?? undefined,
      race: race ?? undefined
    });
    if (!validation.ok) {
      return { ok: false, error: validation.errors.join("; ") };
    }

    writeFileSync(targetPath, `${JSON.stringify(compact, null, 2)}\n`, "utf8");

    return {
      ok: true,
      buildId: req.buildId,
      branchId: req.branchId,
      slot: req.slot,
      label,
      targetFile: targetPath
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
