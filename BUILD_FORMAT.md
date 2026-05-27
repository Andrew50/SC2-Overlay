# Build JSON Format Guide

This project uses a compact build authoring format.

Build files are auto-discovered from the directory configured in `config.json` (`data.buildsPath`, usually `builds`).

## 1) Root Rules (No Index File)

- There is no `index.json`.
- Build IDs are auto-derived from file paths under `buildsPath` (relative path without `.json`, with `/` converted to `.`).
- Across all build files, player root branch names must be present as `zerg`, `terran`, and `protoss`.
- Only one canonical root per player race is allowed globally.
- All three player roots are required.
- Build flow is selected by player race in-app using those canonical roots.
- The player-race selection is auto-included by the app and must not be authored as an in-build `decision` step.
- Everything else branches from those player roots (locally or cross-file).

## 2) Compact Format (Recommended)

Top-level keys are **branch names**.  
Each branch is either:

- a normal branch with `steps`, or
- a branch alias with a branch-level `target`.

### Branch shape

```json
{
  "branch_alias": {
    "target": "shared_opening_branch"
  },
  "branch_name": {
    "steps": [
      {
        "time": "M or M:SS",
        "supply": 21,
        "action": "Do thing",
        "exact": false
      },
      {
        "time": "M or M:SS",
        "supply": 30,
        "decision": {
          "1": { "label": "Left choice", "target": "some_branch" },
          "2": { "label": "Middle choice", "target": "other_branch" },
          "3": { "label": "Right choice", "target": "third_branch" }
        }
      }
    ]
  }
}
```

Branch-level `target` rules:

- `target` at the branch root creates an immediate jump to another branch without a decision prompt.
- Use this for branch aliases that share the same opening branch.
- `target` supports local targets (`"target": "defensive_hold"`) and external targets (`"target": "zp.shared:open"`).
- A branch must define exactly one of `steps` or branch-level `target`.

Step rules:

- each step must include at least one of `action` or `decision`
- decisions use numeric slots:
  - `1` -> left (required)
  - `2` -> middle (required)
  - `3` -> right (optional)
- a branch can have at most one decision step, and it must be the last step in that branch
- keep common order sections shared in one branch; add a decision only when branches diverge by order content or by timing beyond a small window (roughly more than a few seconds)

### Branching strategy (shared-prefix first)

Treat branches as a recursive tree with maximum shared prefix:

- keep all common steps in one core branch
- branch only at the first meaningful divergence
- keep leaf branches for the named final builds

Meaningful divergence means one of these changes first:

- structure or add-on order changes
- gas timing changes (for example, early second gas vs delayed second gas)
- first tech commitment changes (for example, first Starport unit path)

Avoid premature branching:

- bad: branch right after first Refinery if both lines still take second Refinery, Reaper, and Factory in the same order
- good: keep one shared core and branch where the second Refinery timing or Starport commitment actually differs

Avoid single-child gates:

- if a branch only forwards to one target, collapse it into the parent path
- add a decision branch only when there are at least two valid continuations

Use branch aliases (`target`) to keep tree depth readable without duplicating steps:

- use aliases for conceptual grouping nodes
- keep real step timelines in shared core branches

### Player root convention

- Branches named `zerg`, `terran`, and `protoss` are reserved canonical roots.
- Each player root must exist once globally across all discovered files.
- These three names are the explicit race-selection entrypoints used by validation and build loading.
- Branch later inside each race root only when orders actually diverge.
- Non-root build files may omit race branches and just provide reusable branch modules.

### Cross-file branch references

Targets support:

- local branch target: `"target": "defensive_hold"`
- external branch target: `"target": "tvz.modules:air_defense"`

This applies to both decision-branch targets and branch-level `target` aliases.

External targets are auto-imported/resolved by the loader; explicit `imports` are not required in compact files.

## 3) Compact Example

`builds/example.json` should include the required player roots (or split them across files) plus follow-up branches.

```json
{
  "zerg": {
    "steps": [
      { "time": "0:17", "supply": 14, "action": "Supply Depot [ramp]" },
      { "time": "0:42", "supply": 16, "action": "Barracks" },
      {
        "time": "1:55",
        "supply": 24,
        "decision": {
          "1": {
            "label": "3rd Hatchery on time / normal Ling count scouted [standard bio-mine]",
            "target": "zerg_standard_bio_mine"
          },
          "2": {
            "label": "No 3rd Hatchery / Roach Warren scouted [defensive tank/bunker]",
            "target": "zerg_defensive_tank_bunker"
          }
        }
      }
    ]
  },
  "terran": {
    "steps": [
      { "time": "0:17", "supply": 14, "action": "Supply Depot [ramp]" },
      { "time": "0:42", "supply": 16, "action": "Barracks" },
      {
        "time": "2:25",
        "supply": 30,
        "decision": {
          "1": {
            "label": "Terran standard expand scouted [standard marine-tank-raven]",
            "target": "terran_standard_tank_raven"
          },
          "2": {
            "label": "Terran Barracks missing / proxy signs scouted [anti-proxy defense]",
            "target": "terran_anti_proxy_defense"
          }
        }
      }
    ]
  },
  "protoss": {
    "steps": [
      { "time": "0:17", "supply": 14, "action": "Supply Depot [ramp]" },
      { "time": "0:42", "supply": 16, "action": "Barracks" },
      {
        "time": "2:20",
        "supply": 31,
        "decision": {
          "1": {
            "label": "Fast 3rd Nexus scouted [stim timing pressure]",
            "target": "protoss_stim_timing_pressure"
          },
          "2": {
            "label": "Stargate / Oracle scouted [marine/turret/raven defense]",
            "target": "protoss_anti_air_defense"
          }
        }
      }
    ]
  }
}
```

## 4) Naming

Use these naming/format standards to keep branches consistent and readable.

### Branch IDs vs decision labels

Use neutral/mechanics-first IDs for branches, and put scouting context in decision labels.

- branch IDs: `early_second_gas_core`, `reaper_expand_core`, `first_starport_commit`
- decision labels: `Take second gas immediately [3 Reaper 2 Hellion core]`

Include matchup names in branch IDs only when needed for clarity and when that naming is standard online.

### Decision option labels

Decision option labels should include both:

- the **response/build direction**
- the **scouted condition** in brackets

Format:

- `<response type/build direction> [<scouted condition>]`

Examples:

- `Defensive tank/bunker [no 3rd Hatchery / Roach Warren scouted]`
- `Bio-mine anti-air [fast Lair / Spire signs scouted]`
- `Marine/turret/raven defense [Stargate / Oracle scouted]`
- `Anti-proxy defense [Barracks missing / proxy signs scouted]`

Avoid vague labels like `Defend`, `Standard`, `Aggro`, `Macro`.

For popular named builds, prefer the common online name in the response/build portion:

- `3CC reaper expand [early 3rd Command Center]`
- `Cloak banshee [1-1-1 cloak pressure]`
- `Proxy 3-Rax reaper [proxy commitment]`

### Exact step action wording

Action text should be short standardized names, not full sentences.

- Prefer: `Supply Depot [ramp]`, `Barracks`, `Factory`, `Orbital Command`, `Stimpack`
- Avoid: `Build a depot on the ramp`, `Make a barracks`, `Start stim`

Use count prefix format when count > 1:

- `2x Marine`, `4x Hellion`, `2x Barracks`
- not `Marine x2`, `Hellion x4`
- do not write `1x` for single items

### One concrete action per line

Do not combine concrete actions in one step.

- Good:
  - `Reaper`
  - `Orbital Command`
- Bad:
  - `Reaper, Orbital Command`

If an action is concrete, it should be its own step line (units, structures, add-ons, swaps, upgrades, scouting actions, defensive setup, move-outs, rally changes, etc.).

### Bracket content standards

Use brackets for:

- location/placement (`[ramp]`, `[natural]`, `[main mineral line]`)
- scouting instructions (`[check for 3rd Hatchery]`)
- situational instructions (`[add Turrets if fast air is scouted]`)
- non-exact strategic instructions (`[transition to Liberators and Liberator Range]`)
- vision/simcity/defensive nuance (`[vision depot near 3rd]`)

Do not use brackets to hide concrete actions that should be their own step line.

### Loose mid/late-game actions

After the exact opener section, continue using normal step entries with:

- exact timestamps (`M` or `M:SS`)
- usually no `supply` value
- one concrete action/entry per line

Do not use time ranges like `~8:00-9:00` as the standard format.

The renderer keeps each step visible for about 5 seconds after its timestamp, and shows up to 5 queue items at once. Use that behavior to coordinate multiple related entries in the same timing window by giving nearby exact timestamps.

Examples:

- `8 | [expand to 4th if map control is stable]`
- `8:30 | [add Sensor Towers around outer bases]`
- `9 | [move toward late-game bio/ghost/liberator]`

Example timing effect:

- a step at `9` is displayed as current at 9:00 and remains visible until about 9:05.

### Recommended branch content coverage

Each branch should include the categories that matter for execution, where relevant:

- build execution (exact steps, upgrades, swaps, move-out timing)
- scouting triggers (`[check for ...]` and what branch they imply)
- wall/simcity/vision/static defense placement
- defensive unit placement
- composition direction (in decision labels and loose actions)
- production setup and expansion goals
- rally and multiprong/harass intent

## 5) Recursive Terran example (shared core, delayed split)

This pattern shows how to avoid premature branching while keeping clear leaves:

```json
{
  "terran": { "target": "opener_root" },
  "opener_root": {
    "steps": [
      { "time": "0:17", "supply": 14, "action": "Supply Depot [ramp]" },
      {
        "time": "0:35",
        "decision": {
          "1": { "label": "Fast economy opener [CC first]", "target": "cc_first_standard" },
          "2": { "label": "Barracks first macro opener [standard core]", "target": "standard_gate" },
          "3": { "label": "Early proxy commitment [proxy set]", "target": "proxy_gate" }
        }
      }
    ]
  },
  "standard_gate": {
    "steps": [
      { "time": "0:42", "supply": 16, "action": "Barracks" },
      { "time": "0:43", "supply": 16, "action": "Refinery" },
      {
        "time": "0:52",
        "decision": {
          "1": {
            "label": "Delay second gas [one-gas reaper expand core]",
            "target": "no_second_gas_reaper_expand_core"
          },
          "2": {
            "label": "Take second gas immediately [3 Reaper 2 Hellion core]",
            "target": "early_second_gas_core"
          }
        }
      }
    ]
  }
}
```

Notes:

- this separates by the actual second-gas divergence point
- two eventual leaves can stay under one shared core until first Starport commitment diverges
- keep optional responses as bracket notes when strict leaf count is desired
## 6) Validation Workflow

1. Author/update compact build files under `buildsPath` (default `builds/`).
2. Ensure `zerg`, `terran`, and `protoss` roots are defined exactly once globally.
3. Run:

```bash
npm run validate:data
```

This checks schema validity and graph reference resolution.

To print every possible build order traversal (root to leaf) in the terminal:

```bash
npm run builds
```

## 7) Hotkeys and Runtime Behavior

`config.json` controls hotkeys (`choose1`, `choose2`, `choose3`, `reset`, `jumpForward`, `jumpBackward`, `jumpPrevious`, `jumpNext`, plus optional `pause` and `toggleVisibility`) in both focused and global modes.

- `choose1/choose2/choose3` sets the branch option used at the next upcoming decision (`1`, `2`, or `3`), without changing the timer value.
- `jumpNext` advances within the active build branch and then to the next node.
- `jumpPrevious` returns to the previous jump milestone.
- `jumpForward` / `jumpBackward` adjusts timeline by `timer.adjustSeconds` (default `5` seconds).
- `toggleVisibility` can still hide/show the overlay window when bound, but is unbound by default.
