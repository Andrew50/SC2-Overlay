import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CompactBuildFile } from "../types";
import type { SetBranchDisabledRequest, SetBranchDisabledResponse } from "./types";

function targetPathFor(buildsPath: string, buildId: string): string {
  const relative = buildId.split(".").join(path.sep);
  return path.resolve(buildsPath, `${relative}.json`);
}

/**
 * Environment-agnostic branch enable/disable persistence. Reads the target
 * compact file, flips the branch-level `disabled` flag, and writes it back.
 * Shared by the vite dev middleware and Electron IPC, mirroring the import
 * service. Only branches authored directly in the file can be toggled here;
 * imported/aliased branches that don't exist as a compact key are rejected.
 */
export function setBranchDisabled(
  buildsPath: string,
  req: SetBranchDisabledRequest
): SetBranchDisabledResponse {
  try {
    if (!req || !req.buildId) {
      return { ok: false, error: "Missing target build id." };
    }
    if (!req.branchId) {
      return { ok: false, error: "Missing branch id." };
    }

    const targetPath = targetPathFor(buildsPath, req.buildId);
    const compact = JSON.parse(readFileSync(targetPath, "utf8")) as CompactBuildFile;

    const entry = compact[req.branchId];
    if (!entry) {
      return {
        ok: false,
        error: `Branch "${req.branchId}" not found in ${req.buildId}. Imported or shared branches cannot be toggled here.`
      };
    }

    if (req.disabled) {
      entry.disabled = true;
    } else {
      delete entry.disabled;
    }

    writeFileSync(targetPath, `${JSON.stringify(compact, null, 2)}\n`, "utf8");

    return {
      ok: true,
      buildId: req.buildId,
      branchId: req.branchId,
      disabled: req.disabled,
      targetFile: targetPath
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
