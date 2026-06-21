# Build Order Import + Smart Merge — Implementation Plan

## 1. Goal

Let users import standard SC2 build orders (Spawning Tool plain text first, SALT
encoding second) and **merge** them into the existing compact build graph so that
an import branches only at its true point of divergence (within a configurable
~2–3s / ±1 supply tolerance) instead of landing as an isolated path. Provide a
human-in-the-loop preview/diff before any file is written.

## 2. Background / Current State

- Builds are hand-authored compact JSON: top-level keys are branch names, each
  branch is `{ steps: [{ time, supply, action, exact }], <one trailing decision> }`
  or a `{ target }` alias. See `BUILD_FORMAT.md` and `schemas/build.schema.json`.
- The loader (`src/core/loader.ts`) discovers files under `config.json`
  `data.buildsPath`, validates with AJV, normalizes compact → graph
  (`normalizeCompactBuild`), resolves cross-file `buildId:branch` refs, and
  produces `ResolvedBuildGraph` per player race.
- `src/core/graph-traversal.ts` `collectBuildOrders()` flattens every root→leaf
  path into `{ nodePath, steps, choices }` — the ideal structure to match imports
  against.
- Time parsing already exists (`toSeconds` in `src/renderer.ts`, `M` or `M:SS`).
- Viewer (`src/viewer/main.ts`, cytoscape graph) already renders paths and the
  step graph — a good host for the preview UI.
- **No import/export exists today.** No SALT/text parsing anywhere.

### Key constraints from the schema (must hold post-merge)
- A branch has **exactly one** of `steps` or `target`.
- A branch may have **at most one** decision step, and it must be the **last** step.
- Decision slots `1` (left) and `2` (middle) required; `3` (right) optional → **max 3 options**.
- Branch ids match `^[a-zA-Z0-9_.-]+$`; one canonical `zerg`/`terran`/`protoss` root globally.

## 3. Scope

### In scope
- Spawning Tool **plain-text** import → internal `BuildStep[]`.
- SALT **string decode** → `BuildStep[]` (implemented, `src/core/import/parse-salt.ts`).
- Smart merge: find longest matching existing path, split at divergence.
- Patch-based preview/diff + author confirm-and-apply (CLI dry-run, then UI).
- Single-leaf **export** to Spawning Tool text and SALT (phase 2/3).

### Out of scope (v1)
- Replay (`.SC2Replay`) parsing.
- Auto-generating strategic decision **labels/semantics** (author writes those).
- Importing a full multi-branch tree (SALT/ST are linear; one import = one path).

## 4. Data Model Additions

New module `src/core/import/` with shared types:

```ts
// src/core/import/types.ts
export type ImportSourceFormat = "spawningtool-text" | "salt";

export interface ImportedStep {
  raw: string;           // original line
  time?: string;         // normalized "M:SS" if present
  timeSeconds?: number;
  supply?: number;
  action: string;        // normalized canonical action
  actionRaw: string;     // pre-normalization
  isSupplyStructure?: boolean;  // Supply Depot / Overlord / Pylon — matched carefully
  isWorker?: boolean;           // SCV / Probe / Drone — skipped by default
}

export interface ParsedImport {
  format: ImportSourceFormat;
  race?: "terran" | "zerg" | "protoss";   // inferred if possible
  steps: ImportedStep[];
  warnings: string[];
}

export interface MergeMatch {
  pathIndex: number;          // index into collectBuildOrders()
  nodePath: string[];
  matchedStepCount: number;   // length of shared prefix
  divergeNodeId: string;      // branch node where split happens
  divergeStepIndex: number;   // step index within that branch
  score: number;
}

export interface MergePlan {
  match: MergeMatch | null;
  action: "extend" | "add-decision-option" | "split-branch" | "new-root-child";
  newBranchId: string;
  decisionLabel: string;      // author-editable placeholder
  patchedCompact: CompactBuildFile;   // proposed result
  diff: MergeDiff;            // for preview
  warnings: string[];
}
```

## 5. Component Breakdown

### 5.1 Parsers (`src/core/import/parsers/`)

**`parseSpawningToolText(text): ParsedImport`**
- Split into lines; ignore blank lines, comment/header lines, and section
  separators.
- Per line, match the common ST notations:
  - `14 Supply Depot`            → supply + action
  - `0:17 Supply Depot`          → time + action
  - `0:17 14 Supply Depot` / `14 0:17 ...` → both
  - `14  Supply Depot x2`        → count suffix
  - Lines wrapped with extra columns (`|`, tabs) from copy/paste.
- Normalize via `normalizeAction()` (see 5.2); tag `isWorker` / `isSupplyStructure`.
- Infer race from unit/structure vocabulary (Pylon/Gateway → protoss, etc.).
- Collect warnings for unparseable lines rather than throwing.

**`decodeSalt(encoded): ParsedImport`** (implemented)
- Format: `[version][title]|[author]|[desc]|~[block]...`, each block 5 base-95
  chars `[supply][minute][second][type][itemId]`. Spawning Tool's "SALT encoding"
  is this with version `$`, title=build id, author=source.
- Ported the unit/structure/morph/upgrade ID tables from
  `Veritasimo/sc2-scrapbook/SALT.cs`; `supply = mapped + 4` (0 = blank).
- Maps SALT names into the project vocabulary (`Reactor (Barracks)` →
  `Barracks Reactor`, `Zergling - Metabolic Boost` → `Metabolic Boost`, etc.),
  coalesces consecutive identical items into `Nx Unit`, and infers race.
- Validated against build 199819 (decoded build matches the published text).

### 5.2 Action normalization (`src/core/import/normalize.ts`)

- Strip `[brackets]` (preserve separately as optional note).
- Trim, collapse whitespace.
- Alias map → canonical action strings used in this repo:
  - `Depot`, `SD` → `Supply Depot`
  - `OC`, `Orbital` → `Orbital Command`
  - `CC` → `Command Center`
  - `Rax` → `Barracks`, `Fact` → `Factory`, `Port` → `Starport`
  - `Reactor`/`Tech Lab` add-on phrasing, `2x`/`x2` → `2x` prefix per repo rule
- Classify each action:
  - **worker** (`SCV`, `Probe`, `Drone`) → `isWorker = true`
  - **supply structure** (`Supply Depot`, `Overlord`, `Pylon`) → `isSupplyStructure = true`
- Output canonical action + a `confidence` flag; low-confidence → warning.
- Keep the alias + classification tables data-driven (JSON) so they grow without
  code changes.

### 5.3 Matcher (`src/core/import/match.ts`)

**`findMergePoint(graph, imported, opts): MergeMatch | null`**
- `const paths = collectBuildOrders(graph)`.
- For each path, walk imported steps vs path steps computing longest common
  prefix where a pair **matches** when:
  - normalized actions equal (or alias-equal), AND
  - if both have time: `|tA − tB| ≤ opts.timeToleranceSec` (default 3), AND
  - if both have supply: `|sA − sB| ≤ opts.supplyTolerance` (default 1).
- **Worker skipping (default on):** steps with `isWorker` are skipped on either
  side during prefix walking (they rarely appear in authored builds and don't
  define divergence).
- **Supply structures are NOT skipped.** Treat `isSupplyStructure` steps as
  meaningful: they participate in matching with the normal (or slightly tighter)
  tolerance, because supply-structure timing/placement can be strategically
  significant (intentional supply block, hidden/proxy depot, scouting Overlord).
  A supply-structure mismatch is a legitimate divergence point.
- **Auto-pick best match:** score = matched prefix length (tiebreak: closer
  timings, then closer supply). The highest-scoring path is selected
  automatically; `--match-branch` can override.
- Map the prefix end back to `{ divergeNodeId, divergeStepIndex }` using
  `nodePath` + cumulative step counts per build node.
- Return best match, or `null` if score is 0 (attach near root).

### 5.4 Merge planner (`src/core/import/merge.ts`)

**`planMerge(compact, graph, imported, match, opts): MergePlan`**
Chooses one of:

1. **extend** — import is a strict superset of an existing leaf path: append the
   extra tail steps to that leaf branch (no new decision).
2. **add-decision-option** — divergence coincides with an existing decision node
   that has a free slot (`3` empty): add the imported continuation as a 3rd
   option pointing at a new leaf branch.
3. **split-branch** — divergence falls mid-branch (or at a full 3-option
   decision): split the branch:
   - shared steps stay in parent branch,
   - insert a new decision step (becomes the branch's last step),
   - option 1 = existing continuation (move tail into a new branch),
   - option 2 = imported continuation (new leaf branch),
   - respects "decision must be last step" + "max one decision per branch".
4. **new-root-child** — score 0: attach under the race root's first decision (new
   option) or create a sibling opener.

- Generate `newBranchId` from action/condition keywords, sanitized to the id
  pattern, de-duplicated against existing keys.
- `decisionLabel` is a best-effort placeholder (`Imported: <leaf name>`) — flagged
  as **author-editable** in the preview.
- Produce `patchedCompact` (deep clone + edits; never mutate input).
- Emit warnings: >3 options needed, ambiguous normalization, missing timings,
  supply-structure divergence, cycle risk.

### 5.5 Diff generation (`src/core/import/diff.ts`)

**`computeMergeDiff(originalCompact, patchedCompact): MergeDiff`**
- Branch-level diff: added branches, modified branches, added decision options.
- Step-level diff within touched branches (added/unchanged/context).
- Shape designed for both terminal rendering and the viewer UI.

### 5.6 Validation reuse

- After planning, run the patched compact through the **existing** AJV build
  schema + a dry-run `normalizeCompactBuild` + `validateGraphReferences` to
  guarantee the result loads. Surface any error as a blocking preview warning.
- No new validation logic needed — reuse `loader.ts` internals (export a small
  `validateCompact(compact): string[]` helper).

## 6. Human-in-the-loop UX

**Author confirm/apply model:** the tool **never auto-writes back** to a source
file. It always emits a proposed patch (patched compact JSON + diff) that the
author reviews and explicitly applies.

### 6.1 CLI (ships first, fastest to build)

`npm run import-build -- --file path.txt [--format text|salt] --into builds/terran_core_builds.json [--match-branch <id>] [--out patch.json] [--apply]`

- Default = **dry run / emit patch**: prints parsed steps, the auto-selected
  match, merge action, branch diff, and warnings; writes a patch file (or stdout)
  but does not modify the source build.
- `--apply` is the explicit author confirmation step: writes the patched JSON to
  the source file, then runs `validate:data` automatically.
- `--match-branch` forces a specific subtree when the author disagrees with the
  auto-selected best match.
- Reuses `print-build-orders.ts` formatting for before/after readouts.

### 6.2 Viewer preview UI (phase 3)

- "Import build" button in `src/viewer/main.ts` toolbar → modal with:
  - paste box + format selector (auto-detect text vs SALT),
  - parsed-steps table (editable action/time/supply, alias overrides; worker /
    supply-structure tags visible),
  - merge target + **tolerance sliders** (time 0–5s, supply 0–2),
  - live cytoscape preview: existing graph greyed, **new nodes/edges highlighted**
    at the divergence point,
  - editable `decisionLabel` and `newBranchId`,
  - warnings panel,
  - **Apply** (writes file via an Electron IPC handler) / **Cancel**.
- Electron: add a `write-build-file` IPC channel in `electron/main.ts` +
  `electron/preload.ts` (currently read-only data flow), guarded to the
  `buildsPath` directory.

## 7. Config Additions (`config.json` + `schemas/config.schema.json`)

```jsonc
"import": {
  "timeToleranceSec": 3,
  "supplyTolerance": 1,
  "skipWorkers": true,
  "workerActions": ["SCV", "Probe", "Drone"],
  "supplyStructureActions": ["Supply Depot", "Overlord", "Pylon"],
  "defaultFormat": "spawningtool-text"
}
```
All optional with safe defaults so existing configs keep working. Note workers
are skipped by default; supply structures are intentionally **not** in a skip
list and are matched as meaningful steps.

## 8. Export (inverse, phase 2/3)

- **`exportPathAsText(path: BuildOrderPath): string`** — inverse of
  `print-build-orders.ts` `formatStep`; one leaf path → ST text.
- **`encodeSalt(path): string`** — reverse of the decoder; lossy (drops decision
  context), gated behind a "linear export" warning.
- CLI: `npm run export-build -- --branch <leaf-id> --format text|salt`.

## 9. Testing Strategy

Use the built-in **`node:test`** runner (no new dependency) with `tsx`.

- `npm test` → `tsx --test tests/**/*.test.ts` (add script to `package.json`).
- Unit tests:
  - parser: real ST copy-paste fixtures per race + malformed lines.
  - normalize: alias coverage, worker/supply-structure classification, low-confidence flags.
  - matcher: synthetic graph; assert divergence index for known overlaps,
    including ±tolerance edge cases, worker-skipping, and supply-structure
    divergence detection.
  - merge planner: each of the 4 actions; assert schema-valid output.
  - round-trip: text → import → merge → `collectBuildOrders` contains the path.
- Integration: run patched `terran_core_builds.json` through `validate:data`.
- Fixtures under `tests/fixtures/imports/`.

## 10. File / Change Map

| Path | Change |
|------|--------|
| `src/core/import/types.ts` | new shared types |
| `src/core/import/parsers/spawningtool.ts` | text parser |
| `src/core/import/parse-salt.ts` | SALT decode (implemented) |
| `src/core/import/normalize.ts` + `aliases.json` | action canonicalization + worker/supply tagging |
| `src/core/import/match.ts` | `findMergePoint` (auto best match, worker skip) |
| `src/core/import/merge.ts` | `planMerge` (4 strategies) |
| `src/core/import/diff.ts` | diff model + renderers |
| `src/core/loader.ts` | export small `validateCompact()` helper |
| `scripts/import-build.ts` | CLI (emit patch / `--apply`) |
| `scripts/export-build.ts` | export CLI (phase 2/3) |
| `tests/**` | `node:test` suites + fixtures |
| `package.json` | `import-build`, `export-build`, `test` scripts |
| `config.json`, `schemas/config.schema.json` | optional `import` block |
| `electron/main.ts`, `electron/preload.ts` | `write-build-file` IPC (UI phase) |
| `src/viewer/main.ts` + styles | import modal + preview (UI phase) |
| `BUILD_FORMAT.md` | document import/merge workflow |

## 11. Phased Delivery

1. **Phase 1 — Text import + merge (CLI, emit patch).** DONE. Parser, normalize,
   matcher (auto best match + worker skip + careful supply structures), planner,
   diff, `import-build.ts`. `node:test` suites.
2. **Phase 2 — Apply + SALT decode.** DONE. `--apply` write path, SALT decoder +
   ID tables (`parse-salt.ts`).
3. **Phase 3 — Viewer preview UI.** DONE. Import modal with structured diff,
   dev `/api/import` middleware + Electron `app:import-build` IPC, apply + graph
   refresh. (Future: live cytoscape preview, editable labels/tolerances.)
4. **Phase 4 — Export.** Not started. Text + SALT export, docs.

## 12. Risks & Mitigations

- **Ambiguous prefix matches** → auto-pick best by score with `--match-branch`
  override; always show diff before write.
- **Action vocabulary drift** → data-driven alias table; warnings, never silent.
- **Over-aggressive worker skipping** → only the configured worker list is
  skipped; everything else (including supply structures) is matched.
- **Missing strategically-significant supply timing** → supply structures are
  matched as real steps; a supply-structure mismatch is treated as a real
  divergence and flagged in warnings.
- **SALT version/ID drift** → versioned ID tables; treat unknown IDs as warnings.
- **Schema violations after merge** (e.g. >3 options) → reuse loader validation
  as a hard gate; planner detects and proposes nested decision instead.
- **Lossy linear imports** → make explicit in UI; imports never overwrite
  author-written decision semantics.

## 13. Resolved Decisions

- **Test runner:** `node:test` (built-in, no new dependency), run via `tsx`.
- **Match selection:** auto-pick the best-scoring match; author can override with
  `--match-branch`.
- **Write model:** always emit a patch for the author to confirm/apply; never
  silently auto-write back to the source build file.
- **Worker handling:** skip workers (`SCV`/`Probe`/`Drone`) by default during
  matching.
- **Supply structures:** matched carefully as meaningful steps (not skipped),
  because supply-structure timing/placement can matter strategically; mismatches
  count as real divergence points.
