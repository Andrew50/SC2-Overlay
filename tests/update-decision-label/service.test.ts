import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CompactBuildFile } from "../../src/core/types";
import { updateDecisionLabel } from "../../src/core/update-decision-label/service";

function decisionFixture(): CompactBuildFile {
  return {
    zerg: {
      steps: [
        { time: "0:12", supply: 13, action: "Overlord" },
        {
          time: "1:00",
          supply: 18,
          decision: {
            "1": { label: "Ling flood", target: "ling_path" },
            "2": { label: "Roach timing", target: "roach_path" }
          }
        }
      ]
    },
    ling_path: {
      steps: [{ time: "1:30", supply: 20, action: "Zergling" }]
    },
    roach_path: {
      steps: [{ time: "1:30", supply: 20, action: "Roach" }]
    }
  };
}

test("updateDecisionLabel patches the decision label in compact JSON", () => {
  const buildsPath = mkdtempSync(path.join(tmpdir(), "sc2-overlay-label-"));
  const buildId = "test_build";
  const targetPath = path.join(buildsPath, `${buildId}.json`);
  writeFileSync(targetPath, `${JSON.stringify(decisionFixture(), null, 2)}\n`, "utf8");

  const result = updateDecisionLabel(buildsPath, {
    buildId,
    branchId: "zerg",
    slot: "1",
    label: "Speedling all-in"
  });

  assert.equal(result.ok, true);
  assert.equal(result.label, "Speedling all-in");

  const saved = JSON.parse(readFileSync(targetPath, "utf8")) as CompactBuildFile;
  assert.equal(saved.zerg.steps?.[1]?.decision?.["1"].label, "Speedling all-in");
  assert.equal(saved.zerg.steps?.[1]?.decision?.["2"].label, "Roach timing");
});

test("updateDecisionLabel rejects empty labels", () => {
  const buildsPath = mkdtempSync(path.join(tmpdir(), "sc2-overlay-label-"));
  const buildId = "test_build";
  const targetPath = path.join(buildsPath, `${buildId}.json`);
  writeFileSync(targetPath, `${JSON.stringify(decisionFixture(), null, 2)}\n`, "utf8");

  const result = updateDecisionLabel(buildsPath, {
    buildId,
    branchId: "zerg",
    slot: "2",
    label: "   "
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /empty/i);

  const saved = JSON.parse(readFileSync(targetPath, "utf8")) as CompactBuildFile;
  assert.equal(saved.zerg.steps?.[1]?.decision?.["2"].label, "Roach timing");
});

test("updateDecisionLabel rejects branches without a decision step", () => {
  const buildsPath = mkdtempSync(path.join(tmpdir(), "sc2-overlay-label-"));
  const buildId = "test_build";
  const targetPath = path.join(buildsPath, `${buildId}.json`);
  writeFileSync(targetPath, `${JSON.stringify(decisionFixture(), null, 2)}\n`, "utf8");

  const result = updateDecisionLabel(buildsPath, {
    buildId,
    branchId: "ling_path",
    slot: "1",
    label: "Nope"
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no decision step/i);
});

test("updateDecisionLabel rejects missing decision slots", () => {
  const buildsPath = mkdtempSync(path.join(tmpdir(), "sc2-overlay-label-"));
  const buildId = "test_build";
  const targetPath = path.join(buildsPath, `${buildId}.json`);
  writeFileSync(targetPath, `${JSON.stringify(decisionFixture(), null, 2)}\n`, "utf8");

  const result = updateDecisionLabel(buildsPath, {
    buildId,
    branchId: "zerg",
    slot: "3",
    label: "Third option"
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /slot "3"/i);
});
