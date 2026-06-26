import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CompactBuildFile, ResolvedBuildGraph } from "../types";
import { resolveCompactFileToGraph } from "../loader";
import { importBuildOrder } from "./index";
import type { ImportPreviewRequest, ImportPreviewResponse, OpponentRace } from "./types";

function targetPathFor(buildsPath: string, buildId: string): string {
  const relative = buildId.split(".").join(path.sep);
  return path.resolve(buildsPath, `${relative}.json`);
}

/**
 * Environment-agnostic import entry point. Reads the target compact file from
 * `buildsPath`, computes the merge plan, optionally applies it, and returns a
 * serializable result. Used by both the vite dev middleware and Electron IPC.
 */
export function runImport(buildsPath: string, req: ImportPreviewRequest): ImportPreviewResponse {
  try {
    if (!req || typeof req.text !== "string" || req.text.trim().length === 0) {
      return { ok: false, error: "Paste a build order (or SALT string) first." };
    }
    if (!req.buildId) {
      return { ok: false, error: "Missing target build id." };
    }

    const targetPath = targetPathFor(buildsPath, req.buildId);
    // The target file may not exist yet (importing the first build for a race,
    // or after clearing builds). Start from an empty compact in that case; the
    // import engine will seed the race root from the imported steps.
    const compact: CompactBuildFile = existsSync(targetPath)
      ? (JSON.parse(readFileSync(targetPath, "utf8")) as CompactBuildFile)
      : {};

    const { parsed, plan, validationErrors } = importBuildOrder(compact, req.text, {
      targetBuildId: req.buildId,
      race: req.race as OpponentRace | undefined,
      importName: req.name && req.name.trim().length > 0 ? req.name.trim() : undefined,
      outputSkipWorkers: !req.keepWorkers,
      timeToleranceSec: req.timeToleranceSec,
      supplyTolerance: req.supplyTolerance
    });

    let applied = false;
    if (req.apply && validationErrors.length === 0) {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, `${JSON.stringify(plan.patchedCompact, null, 2)}\n`, "utf8");
      applied = true;
    }

    // Resolve the patched compact into a graph so the viewer can render the
    // proposed branch diff directly in the build graph. Skip when invalid.
    const race = (req.race ?? parsed.race) as OpponentRace | undefined;
    const rootBranchId = race;
    let patchedGraph: ResolvedBuildGraph | undefined;
    if (race && rootBranchId && validationErrors.length === 0) {
      try {
        patchedGraph = resolveCompactFileToGraph(plan.patchedCompact, {
          buildId: req.buildId,
          rootBranchId,
          race
        });
      } catch {
        patchedGraph = undefined;
      }
    }

    return {
      ok: true,
      format: parsed.format,
      race: parsed.race ?? req.race,
      name: parsed.name,
      stepsParsed: parsed.steps.length,
      parserWarnings: parsed.warnings,
      action: plan.action,
      newBranchId: plan.newBranchId,
      matchedStepCount: plan.match?.matchedStepCount ?? null,
      divergeNodeId: plan.match?.divergeNodeId ?? null,
      divergeStepIndex: plan.match?.divergeStepIndex ?? null,
      diff: plan.diff,
      patchedGraph,
      rootBranchId,
      planWarnings: plan.warnings,
      validationErrors,
      applied,
      targetFile: targetPath
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
