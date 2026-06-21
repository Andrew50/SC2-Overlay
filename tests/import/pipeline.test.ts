import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CompactBuildFile } from "../../src/core/types";
import {
  decodeSalt,
  detectFormat,
  importBuildOrder,
  normalizeAction,
  parseSpawningToolText
} from "../../src/core/import";
import { resolveCompactFileToGraph } from "../../src/core/loader";
import { buildStepGraph } from "../../src/viewer/graph-viz";

const ZVT_SALT =
  '$199819|spawningtool.com||~* - C+ 4!?, L D.!% C-!* I1!X!@1!X!@1!Z!C1" !?7"+#J;"@!@>"J D="O!?D#* HI#1 CI#4!@K#<!@S#R!AS#R!AS#R!AS#R!A]$: L]$: Lc$C Cc$C Cg$H';

const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/imports/zvt_199819.txt");

test("normalizeAction extracts canonical name, count and note", () => {
  const a = normalizeAction("Roach x4 4 Safety Roaches");
  assert.equal(a.action, "4x Roach");
  assert.equal(a.matchKey, "roach");
  assert.equal(a.count, 4);
  assert.equal(a.note, "4 Safety Roaches");

  const b = normalizeAction("Hatchery 2nd");
  assert.equal(b.action, "Hatchery");
  assert.equal(b.note, "2nd");

  const c = normalizeAction("Spore Crawler x2 Main, Natural");
  assert.equal(c.action, "2x Spore Crawler");
  assert.equal(c.matchKey, "spore crawler");
});

test("normalizeAction classifies workers and supply structures", () => {
  assert.equal(normalizeAction("Drone").isWorker, true);
  assert.equal(normalizeAction("Overlord").isSupplyStructure, true);
  assert.equal(normalizeAction("Supply Depot").isSupplyStructure, true);
  assert.equal(normalizeAction("Pylon").isSupplyStructure, true);
  assert.equal(normalizeAction("Zergling").isWorker, false);
});

test("parseSpawningToolText parses the markdown table and infers race", () => {
  const text = readFileSync(FIXTURE, "utf8");
  const parsed = parseSpawningToolText(text);
  assert.equal(parsed.race, "zerg");
  // Workers stay in the parsed list; they are filtered later during matching.
  const drones = parsed.steps.filter((s) => s.isWorker);
  assert.ok(drones.length >= 5, "should parse Drone lines");
  const pool = parsed.steps.find((s) => s.matchKey === "spawning pool");
  assert.ok(pool, "Spawning Pool parsed");
  assert.equal(pool?.supply, 17);
});

function smallLinearBuild(): CompactBuildFile {
  return {
    zerg: {
      steps: [
        { time: "0:12", supply: 13, action: "Overlord" },
        { time: "0:44", supply: 17, action: "Extractor" },
        { time: "0:50", supply: 17, action: "Spawning Pool" },
        { time: "1:18", supply: 18, action: "Hatchery" }
      ]
    }
  };
}

test("merge splits a branch at the true divergence point", () => {
  const compact = smallLinearBuild();
  const input = ["13 0:12 Overlord", "17 0:44 Extractor", "17 0:50 Spawning Pool", "20 1:20 Zergling"].join("\n");
  const { plan, validationErrors } = importBuildOrder(compact, input, {
    targetBuildId: "test",
    race: "zerg",
    importName: "Ling Follow Up"
  });

  assert.equal(plan.action, "split-branch");
  assert.deepEqual(validationErrors, []);
  // Shared prefix (3 steps) stays on the root branch, now ending in a decision.
  const rootSteps = plan.patchedCompact.zerg.steps ?? [];
  assert.equal(rootSteps.length, 4);
  assert.ok(rootSteps[3].decision, "root ends in a decision");
  // The imported tail lives in its own branch.
  assert.ok(plan.patchedCompact[plan.newBranchId].steps?.some((s) => s.action === "Zergling"));
});

test("supply differences do not branch when action and time agree", () => {
  // Mirrors the real case: both builds make 2x Zergling at 1:37 right after the
  // Queen, but the imported build is at supply 18 while the existing is at 20
  // (different worker timing). The true divergence is the next step.
  const compact: CompactBuildFile = {
    zerg: {
      steps: [
        { time: "1:36", supply: 18, action: "Queen" },
        { time: "1:37", supply: 20, action: "2x Zergling" },
        { time: "1:45", supply: 21, action: "Metabolic Boost" }
      ]
    }
  };
  const input = ["18 1:36 Queen", "18 1:37 Zergling x2", "22 1:47 Overlord"].join("\n");
  const { plan, validationErrors } = importBuildOrder(compact, input, {
    targetBuildId: "test",
    race: "zerg",
    importName: "Overlord Follow Up"
  });

  assert.deepEqual(validationErrors, []);
  // Queen + 2x Zergling are shared; supply 18 vs 20 must not force a branch.
  assert.equal(plan.match?.matchedStepCount, 2);
  assert.equal(plan.action, "split-branch");
  // The split keeps Queen + 2x Zergling on the shared branch (3 entries incl. decision).
  const rootSteps = plan.patchedCompact.zerg.steps ?? [];
  assert.equal(rootSteps.length, 3);
  assert.ok(rootSteps[2].decision, "shared branch ends in a decision after the Zerglings");
  assert.ok(plan.patchedCompact[plan.newBranchId].steps?.some((s) => s.action === "Overlord"));
});

test("merge adds a third option at an existing decision", () => {
  const compact: CompactBuildFile = {
    zerg: {
      steps: [
        { time: "0:12", supply: 13, action: "Overlord" },
        { time: "0:50", supply: 17, action: "Spawning Pool" },
        {
          time: "1:18",
          decision: {
            "1": { label: "Ling", target: "ling_follow" },
            "2": { label: "Roach", target: "roach_follow" }
          }
        }
      ]
    },
    ling_follow: { steps: [{ time: "1:30", action: "Zergling" }] },
    roach_follow: { steps: [{ time: "1:30", action: "Roach Warren" }] }
  };
  const input = ["13 0:12 Overlord", "17 0:50 Spawning Pool", "18 1:20 Baneling Nest"].join("\n");
  const { plan, validationErrors } = importBuildOrder(compact, input, {
    targetBuildId: "test",
    race: "zerg",
    importName: "Bane Follow Up"
  });

  assert.equal(plan.action, "add-decision-option");
  assert.deepEqual(validationErrors, []);
  const decision = plan.patchedCompact.zerg.steps?.[2].decision;
  assert.ok(decision?.["3"], "third option added");
  assert.equal(decision?.["3"]?.target, plan.newBranchId);
});

test("buildStepGraph renders a decision at the race root", () => {
  // new-root-child merges produce a decision-only root branch. The renderer must
  // synthesize a start anchor instead of throwing "requires an incoming step".
  const compact: CompactBuildFile = {
    zerg: {
      steps: [
        {
          time: "0:00",
          decision: {
            "1": { label: "Existing [existing build]", target: "opener_a" },
            "2": { label: "Imported [imported]", target: "opener_b" }
          }
        }
      ]
    },
    opener_a: { steps: [{ time: "0:12", supply: 13, action: "Overlord" }] },
    opener_b: { steps: [{ time: "0:13", supply: 14, action: "Extractor" }] }
  };

  const graph = resolveCompactFileToGraph(compact, {
    buildId: "test",
    rootBranchId: "zerg",
    race: "zerg"
  });

  const view = buildStepGraph(graph);
  const nodeIds = view.elements.filter((e) => e.group === "nodes").map((e) => e.data.id);
  assert.ok(nodeIds.includes("zerg::start"), "synthesizes a start anchor node");
  assert.ok(nodeIds.some((id) => id.startsWith("opener_a::")), "renders the existing opener");
  assert.ok(nodeIds.some((id) => id.startsWith("opener_b::")), "renders the imported opener");

  // The anchor fans out to both openers via labeled branch edges.
  const anchorEdges = view.elements.filter((e) => e.group === "edges" && e.data.source === "zerg::start");
  assert.equal(anchorEdges.length, 2);
  assert.ok(anchorEdges.every((e) => e.data.edgeKind === "branch"));
});

test("detectFormat recognizes SALT wrappers and plain text", () => {
  assert.equal(detectFormat(ZVT_SALT), "salt");
  assert.equal(detectFormat("14 0:14 Extractor\n15 0:21 Overlord"), "spawningtool-text");
});

test("decodeSalt decodes the ZvT SALT string to the expected build", () => {
  const parsed = decodeSalt(ZVT_SALT);
  assert.equal(parsed.race, "zerg");
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.steps[0].matchKey, "extractor");
  assert.equal(parsed.steps[0].supply, 14);
  assert.ok(parsed.steps.some((s) => s.matchKey === "metabolic boost"));
  const roach = parsed.steps.find((s) => s.matchKey === "roach");
  assert.equal(roach?.action, "4x Roach");
});

test("importing the SALT string branches at the race root like the text import", () => {
  const zpForSalt = JSON.parse(
    readFileSync(path.resolve(process.cwd(), "builds/zp.json"), "utf8")
  ) as CompactBuildFile;
  const { parsed, plan, validationErrors } = importBuildOrder(zpForSalt, ZVT_SALT, {
    targetBuildId: "zp",
    importName: "ZvT (from SALT)"
  });
  assert.equal(parsed.format, "salt");
  assert.equal(plan.action, "new-root-child");
  assert.deepEqual(validationErrors, []);
});

test("merge branches at the race root when nothing matches (ZvT fixture)", () => {
  const zp = JSON.parse(readFileSync(path.resolve(process.cwd(), "builds/zp.json"), "utf8")) as CompactBuildFile;
  const input = readFileSync(FIXTURE, "utf8");
  const { parsed, plan, validationErrors } = importBuildOrder(zp, input, {
    targetBuildId: "zp",
    importName: "ZvT Update Standard Opening"
  });

  assert.equal(parsed.race, "zerg");
  assert.equal(plan.action, "new-root-child");
  assert.deepEqual(validationErrors, []);
  // Root becomes a decision between the existing opener and the import.
  const rootDecision = plan.patchedCompact.zerg.steps?.[0].decision;
  assert.ok(rootDecision, "root now holds a decision");
  assert.equal(rootDecision?.["2"]?.target, plan.newBranchId);
  // Workers are dropped from the generated branch by default.
  const generated = plan.patchedCompact[plan.newBranchId].steps ?? [];
  assert.ok(generated.length > 0);
  assert.ok(!generated.some((s) => (s.action ?? "").toLowerCase().startsWith("drone")));
});
