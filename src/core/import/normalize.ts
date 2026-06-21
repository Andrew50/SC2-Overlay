import type { OpponentRace } from "./types";

/**
 * Canonical SC2 names this project authors builds with. Multi-word entries are
 * matched as token prefixes (longest match wins), so trailing descriptive text
 * in imported lines (e.g. "Hatchery 2nd", "Queen Natural") is split off as a note.
 */
interface ActionDef {
  canonical: string;
  race: OpponentRace | "neutral";
  isWorker?: boolean;
  isSupplyStructure?: boolean;
  /** Alternate spellings/abbreviations seen in imports (lowercased, token-joined by space). */
  aliases?: string[];
}

const ACTION_DEFS: ActionDef[] = [
  // Zerg
  { canonical: "Drone", race: "zerg", isWorker: true },
  { canonical: "Overlord", race: "zerg", isSupplyStructure: true },
  { canonical: "Overseer", race: "zerg" },
  { canonical: "Extractor", race: "zerg" },
  { canonical: "Hatchery", race: "zerg" },
  { canonical: "Lair", race: "zerg" },
  { canonical: "Hive", race: "zerg" },
  { canonical: "Spawning Pool", race: "zerg", aliases: ["pool"] },
  { canonical: "Roach Warren", race: "zerg" },
  { canonical: "Baneling Nest", race: "zerg" },
  { canonical: "Evolution Chamber", race: "zerg", aliases: ["evo chamber", "evo"] },
  { canonical: "Spore Crawler", race: "zerg", aliases: ["spore"] },
  { canonical: "Spine Crawler", race: "zerg", aliases: ["spine"] },
  { canonical: "Hydralisk Den", race: "zerg" },
  { canonical: "Lurker Den", race: "zerg" },
  { canonical: "Infestation Pit", race: "zerg" },
  { canonical: "Nydus Network", race: "zerg" },
  { canonical: "Greater Spire", race: "zerg" },
  { canonical: "Spire", race: "zerg" },
  { canonical: "Ultralisk Cavern", race: "zerg" },
  { canonical: "Zergling", race: "zerg", aliases: ["ling"] },
  { canonical: "Baneling", race: "zerg", aliases: ["bane"] },
  { canonical: "Roach", race: "zerg" },
  { canonical: "Ravager", race: "zerg" },
  { canonical: "Hydralisk", race: "zerg", aliases: ["hydra"] },
  { canonical: "Lurker", race: "zerg" },
  { canonical: "Mutalisk", race: "zerg", aliases: ["muta"] },
  { canonical: "Corruptor", race: "zerg" },
  { canonical: "Infestor", race: "zerg" },
  { canonical: "Swarm Host", race: "zerg" },
  { canonical: "Ultralisk", race: "zerg" },
  { canonical: "Queen", race: "zerg" },
  { canonical: "Metabolic Boost", race: "zerg", aliases: ["ling speed", "metabolic boost"] },
  { canonical: "Centrifugal Hooks", race: "zerg", aliases: ["bane speed"] },
  { canonical: "Pneumatized Carapace", race: "zerg", aliases: ["overlord speed"] },
  { canonical: "Glial Reconstitution", race: "zerg", aliases: ["roach speed"] },
  { canonical: "Zerg Ground Armor Level 1", race: "zerg", aliases: ["ground carapace level 1", "carapace level 1"] },
  { canonical: "Zerg Ground Armor Level 2", race: "zerg" },
  { canonical: "Zerg Missile Weapons Level 1", race: "zerg" },
  { canonical: "Zerg Melee Weapons Level 1", race: "zerg" },
  { canonical: "Extractor Trick", race: "zerg" },

  // Terran
  { canonical: "SCV", race: "terran", isWorker: true },
  { canonical: "Supply Depot", race: "terran", isSupplyStructure: true, aliases: ["depot", "sd"] },
  { canonical: "Command Center", race: "terran", aliases: ["cc"] },
  { canonical: "Orbital Command", race: "terran", aliases: ["orbital", "oc"] },
  { canonical: "Planetary Fortress", race: "terran", aliases: ["pf"] },
  { canonical: "Barracks Reactor", race: "terran" },
  { canonical: "Barracks Tech Lab", race: "terran" },
  { canonical: "Factory Reactor", race: "terran" },
  { canonical: "Factory Tech Lab", race: "terran" },
  { canonical: "Starport Reactor", race: "terran" },
  { canonical: "Starport Tech Lab", race: "terran" },
  { canonical: "Barracks", race: "terran", aliases: ["rax"] },
  { canonical: "Refinery", race: "terran" },
  { canonical: "Factory", race: "terran", aliases: ["fact"] },
  { canonical: "Starport", race: "terran", aliases: ["port"] },
  { canonical: "Engineering Bay", race: "terran", aliases: ["ebay"] },
  { canonical: "Armory", race: "terran" },
  { canonical: "Bunker", race: "terran" },
  { canonical: "Missile Turret", race: "terran" },
  { canonical: "Sensor Tower", race: "terran" },
  { canonical: "Fusion Core", race: "terran" },
  { canonical: "Ghost Academy", race: "terran" },
  { canonical: "Reactor", race: "terran" },
  { canonical: "Tech Lab", race: "terran" },
  { canonical: "Marine", race: "terran" },
  { canonical: "Marauder", race: "terran" },
  { canonical: "Reaper", race: "terran" },
  { canonical: "Ghost", race: "terran" },
  { canonical: "Hellion", race: "terran" },
  { canonical: "Hellbat", race: "terran" },
  { canonical: "Widow Mine", race: "terran" },
  { canonical: "Cyclone", race: "terran" },
  { canonical: "Siege Tank", race: "terran", aliases: ["tank"] },
  { canonical: "Thor", race: "terran" },
  { canonical: "Medivac", race: "terran" },
  { canonical: "Viking", race: "terran" },
  { canonical: "Liberator", race: "terran" },
  { canonical: "Banshee", race: "terran" },
  { canonical: "Raven", race: "terran" },
  { canonical: "Battlecruiser", race: "terran", aliases: ["bc"] },
  { canonical: "Stimpack", race: "terran", aliases: ["stim"] },
  { canonical: "Combat Shield", race: "terran" },
  { canonical: "Concussive Shells", race: "terran" },

  // Protoss
  { canonical: "Probe", race: "protoss", isWorker: true },
  { canonical: "Pylon", race: "protoss", isSupplyStructure: true },
  { canonical: "Nexus", race: "protoss" },
  { canonical: "Assimilator", race: "protoss" },
  { canonical: "Gateway", race: "protoss" },
  { canonical: "Warp Gate", race: "protoss" },
  { canonical: "Cybernetics Core", race: "protoss", aliases: ["cyber core", "cybercore"] },
  { canonical: "Forge", race: "protoss" },
  { canonical: "Photon Cannon", race: "protoss", aliases: ["cannon"] },
  { canonical: "Shield Battery", race: "protoss" },
  { canonical: "Twilight Council", race: "protoss" },
  { canonical: "Robotics Facility", race: "protoss", aliases: ["robo"] },
  { canonical: "Robotics Bay", race: "protoss", aliases: ["robo bay"] },
  { canonical: "Stargate", race: "protoss" },
  { canonical: "Fleet Beacon", race: "protoss" },
  { canonical: "Templar Archives", race: "protoss" },
  { canonical: "Dark Shrine", race: "protoss" },
  { canonical: "Zealot", race: "protoss" },
  { canonical: "Stalker", race: "protoss" },
  { canonical: "Sentry", race: "protoss" },
  { canonical: "Adept", race: "protoss" },
  { canonical: "High Templar", race: "protoss", aliases: ["ht"] },
  { canonical: "Dark Templar", race: "protoss", aliases: ["dt"] },
  { canonical: "Archon", race: "protoss" },
  { canonical: "Immortal", race: "protoss" },
  { canonical: "Observer", race: "protoss" },
  { canonical: "Warp Prism", race: "protoss" },
  { canonical: "Colossus", race: "protoss" },
  { canonical: "Disruptor", race: "protoss" },
  { canonical: "Phoenix", race: "protoss" },
  { canonical: "Oracle", race: "protoss" },
  { canonical: "Void Ray", race: "protoss" },
  { canonical: "Tempest", race: "protoss" },
  { canonical: "Carrier", race: "protoss" },
  { canonical: "Mothership", race: "protoss" },
  { canonical: "Warp Gate Research", race: "protoss" },
  { canonical: "Charge", race: "protoss" },
  { canonical: "Blink", race: "protoss" },
  { canonical: "Extended Thermal Lance", race: "protoss", aliases: ["thermal lance"] },
  { canonical: "Protoss Ground Weapons Level 1", race: "protoss" },
  { canonical: "Protoss Ground Weapons Level 2", race: "protoss" },
  { canonical: "Protoss Ground Armor Level 1", race: "protoss" }
];

interface NormalizedAction {
  action: string;
  matchKey: string;
  count: number;
  note?: string;
  isWorker: boolean;
  isSupplyStructure: boolean;
  race?: OpponentRace;
  confident: boolean;
}

interface PreparedDef {
  def: ActionDef;
  tokens: string[];
}

const PREPARED: PreparedDef[] = [];
for (const def of ACTION_DEFS) {
  PREPARED.push({ def, tokens: tokenize(def.canonical) });
  for (const alias of def.aliases ?? []) {
    PREPARED.push({ def, tokens: tokenize(alias) });
  }
}
// Longest token sequences first so multi-word names win over their prefixes.
PREPARED.sort((a, b) => b.tokens.length - a.tokens.length);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[,/]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function extractCount(tokens: string[]): { tokens: string[]; count: number } {
  // Leading "2x" / "x2"
  const leading = tokens[0]?.match(/^(\d+)x$/) ?? tokens[0]?.match(/^x(\d+)$/);
  if (leading) {
    return { tokens: tokens.slice(1), count: Number(leading[1]) };
  }
  // Trailing "x2" anywhere (commonly right after the unit name)
  for (let i = 1; i < tokens.length; i += 1) {
    const m = tokens[i].match(/^x(\d+)$/);
    if (m) {
      const remaining = [...tokens.slice(0, i), ...tokens.slice(i + 1)];
      return { tokens: remaining, count: Number(m[1]) };
    }
  }
  return { tokens, count: 1 };
}

export function normalizeAction(rawAction: string): NormalizedAction {
  const cleaned = rawAction.trim();
  const baseTokens = tokenize(cleaned);
  const { tokens, count } = extractCount(baseTokens);

  for (const prepared of PREPARED) {
    if (matchesPrefix(tokens, prepared.tokens)) {
      const remainder = tokens.slice(prepared.tokens.length);
      const note = remainder.length > 0 ? rebuildNote(cleaned, prepared.tokens.length, count) : undefined;
      const canonical = prepared.def.canonical;
      const action = count > 1 ? `${count}x ${canonical}` : canonical;
      return {
        action,
        matchKey: canonical.toLowerCase(),
        count,
        note,
        isWorker: Boolean(prepared.def.isWorker),
        isSupplyStructure: Boolean(prepared.def.isSupplyStructure),
        race: prepared.def.race === "neutral" ? undefined : prepared.def.race,
        confident: true
      };
    }
  }

  // Unknown action: keep the original text, match on the lowercased first token.
  const fallback = cleaned || rawAction;
  return {
    action: fallback,
    matchKey: tokens.join(" "),
    count,
    note: undefined,
    isWorker: false,
    isSupplyStructure: false,
    race: undefined,
    confident: false
  };
}

function matchesPrefix(tokens: string[], prefix: string[]): boolean {
  if (prefix.length === 0 || tokens.length < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (tokens[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Re-derive the human-readable note from the original (non-lowercased) text by
 * dropping the count token(s) and the matched canonical tokens.
 */
function rebuildNote(original: string, matchedTokenCount: number, count: number): string | undefined {
  const words = original.split(/\s+/).filter(Boolean);
  let cursor = 0;
  // Skip a leading count token if present.
  if (count > 1 && /^(\d+x|x\d+)$/i.test(words[cursor] ?? "")) {
    cursor += 1;
  }
  let consumed = 0;
  while (cursor < words.length && consumed < matchedTokenCount) {
    if (/^x\d+$/i.test(words[cursor])) {
      cursor += 1;
      continue;
    }
    cursor += 1;
    consumed += 1;
  }
  // Drop a trailing-count token immediately after the name.
  if (/^x\d+$/i.test(words[cursor] ?? "")) {
    cursor += 1;
  }
  const note = words.slice(cursor).join(" ").trim();
  return note.length > 0 ? note : undefined;
}

const RACE_HINT_KEYS = new Map<OpponentRace, Set<string>>();
for (const def of ACTION_DEFS) {
  if (def.race === "neutral") {
    continue;
  }
  const set = RACE_HINT_KEYS.get(def.race) ?? new Set<string>();
  set.add(def.canonical.toLowerCase());
  RACE_HINT_KEYS.set(def.race, set);
}

export function inferRace(matchKeys: string[]): OpponentRace | undefined {
  const tally: Record<OpponentRace, number> = { terran: 0, zerg: 0, protoss: 0 };
  for (const key of matchKeys) {
    for (const race of ["terran", "zerg", "protoss"] as OpponentRace[]) {
      if (RACE_HINT_KEYS.get(race)?.has(key)) {
        tally[race] += 1;
      }
    }
  }
  const ranked = (Object.entries(tally) as Array<[OpponentRace, number]>).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] === 0 || ranked[0][1] === ranked[1][1]) {
    return ranked[0][1] === 0 ? undefined : ranked[0][0];
  }
  return ranked[0][0];
}

export function actionForOutput(action: string, note?: string): string {
  if (note && note.trim().length > 0) {
    return `${action} [${note.trim()}]`;
  }
  return action;
}
