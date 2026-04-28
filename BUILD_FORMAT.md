# Build JSON Format Guide

This project uses a compact build authoring format.

Build files are auto-discovered from the directory configured in `config.json` (`data.buildsPath`, usually `builds`).

## 1) Root Rules (No Index File)

- There is no `index.json`.
- Build IDs are auto-derived from file paths under `buildsPath` (relative path without `.json`, with `/` converted to `.`).
- Across all build files, the root branch names `zerg`, `terran`, and `protoss` must each be defined exactly once.
- Only one definition per race root is allowed globally.
- Every race root is required; missing any of `zerg`, `terran`, or `protoss` is invalid.
- Everything else branches from those race roots (locally or cross-file).

## 2) Compact Format (Recommended)

Top-level keys are **branch names**.  
Each branch contains `steps`.

### Branch shape

```json
{
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

Step rules:

- each step must include at least one of `action` or `decision`
- decisions use numeric slots:
  - `1` -> left (required)
  - `2` -> middle (required)
  - `3` -> right (optional)
- a branch can have at most one decision step, and it must be the last step in that branch

### Root branch convention

- The branches named `zerg`, `terran`, and `protoss` are reserved race roots.
- Each must exist once globally across all discovered files.
- Non-root build files may omit race branches and just provide reusable branch modules.

### Cross-file branch references

Decision targets support:

- local branch target: `"target": "defensive_hold"`
- external branch target: `"target": "tvz.modules:air_defense"`

External targets are auto-imported/resolved by the loader; explicit `imports` are not required in compact files.

## 3) Compact Example

`builds/example.json` includes all three required race roots plus two branches for each race.

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

### Decision option labels

Decision option labels should include both:

- the **scouted condition**
- the **response/build direction** in brackets

Format:

- `<scouted condition> [<response type/build direction>]`

Examples:

- `No 3rd Hatchery / Roach Warren scouted [defensive tank/bunker]`
- `Fast Lair / Spire signs scouted [bio-mine anti-air]`
- `Stargate / Oracle scouted [marine/turret/raven defense]`
- `Barracks missing / proxy signs scouted [anti-proxy defense]`

Avoid vague labels like `Defend`, `Standard`, `Aggro`, `Macro`.

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

## 5) Validation Workflow

1. Author/update compact build files under `buildsPath` (default `builds/`).
2. Ensure race roots `zerg`, `terran`, and `protoss` are each defined exactly once globally.
3. Run:

```bash
npm run validate:data
```

This checks schema validity and graph reference resolution.

## 6) Hotkeys and Runtime Behavior

`config.json` controls hotkeys (`left`, `middle`, `right`, `pause`, `reset`, `next`) in both focused and global modes.

- `next` advances within the active build branch and then to next node.
- On decisions, `left/middle/right` selects branches.
- Timer starts after opponent race is selected and can be adjusted by `left/right` based on `timer.adjustSeconds`.
