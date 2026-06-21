# SC2 Overlay

A desktop overlay for StarCraft II that walks you through build orders while you play. It sits on top of the game as a small always-on-top window with a game timer and a rolling queue of upcoming actions. When your build has forks—different responses based on what you scout—you pick a branch with hotkeys and the overlay continues down that path.

Build data lives in JSON files under `builds/`. Each file is a tree of branches: timed steps (supply, action, timestamp) and decision points where you choose what to do next. The app loads all build files, resolves cross-file references, and presents one graph per player race (Terran, Zerg, Protoss).

## Overlay

On launch you pick your race. A countdown runs, then the timer advances in real time and the overlay shows the current step plus the next few actions. Each row includes supply and time when available. Steps that are due soon are highlighted.

Global hotkeys (configurable in `config.json`) work while StarCraft is focused:

- **F1 / F2 / F3** — choose branch option 1, 2, or 3 at the current or next decision
- **F5 / F6** — jump the timer backward or forward by 5 seconds
- **F7 / F8** — jump to the previous or next build step
- **F4** — reset back to race selection
- **F9** — open the build viewer

You can also pre-select a branch before you reach a decision: the choice is remembered and applied when the timer gets there. The header shows which branch path you are on.

The overlay window is transparent, frameless, and optionally click-through so it does not block the game.

## Decisions

Builds branch at decision nodes. Each decision presents up to three labeled options—usually tied to scouting reads or matchup choices (for example, “Proxy 2-Rax” vs “At-home Barracks”). Picking an option switches the overlay to that branch’s steps.

Decision trees share common openings where possible and split only when the build order actually diverges. That keeps early game steps identical across related builds until a real choice appears.

## Build viewer

Press F9 (or use the toolbar button) to open the Build Orders window. This is a separate window with:

- An interactive graph of the full build tree (steps, branch points, terminal nodes)
- A list of every complete path from opener to finish
- A step-by-step readout for the selected path

Click nodes or paths to explore how builds connect. The graph uses color to distinguish regular steps, branch points, and end nodes.

## Import builds

In the viewer, **Import build** accepts a Spawning Tool build order (the table under “Build Order”) or a SALT string. The importer parses the steps, matches them against the existing tree for the active race, and merges at the first point of difference—reusing shared prefixes instead of duplicating them. Preview the diff before applying; the patched JSON is written back to the build file.

CLI import is also available:

```bash
npm run import-build -- --help
```

## Practice mode

In the viewer, select a complete build path and click **Practice this build**. The overlay switches back with that path’s branch choices already set. Decisions are locked so you run through one fixed build order without re-picking forks—useful for drilling a specific line until the timings stick.

## Development

```bash
npm install
npm run dev          # overlay (Electron + Vite)
npm run view         # build viewer only (browser)
npm run validate:data
npm run test
npm run builds       # print all build paths to the terminal
```

Packaged builds: `npm run dist` (or `dist:linux`, `dist:mac`, `dist:win`).

Build authoring format and naming conventions are documented in [BUILD_FORMAT.md](BUILD_FORMAT.md).
