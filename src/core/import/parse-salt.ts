import type { ImportedStep, ParsedImport } from "./types";
import { inferRace, normalizeAction } from "./normalize";

/**
 * SALT build-order decoder.
 *
 * Format (see Veritasimo/sc2-scrapbook SALT.cs):
 *   [version][title]|[author]|[description]|~[block][block]...
 * where each block is 5 characters: [supply][minute][second][type][itemId].
 * Every character maps to an index into CHARACTERS (base-95). Spawning Tool's
 * "SALT encoding" is exactly this with version `$`, title=build id, author=source.
 */
const CHARACTERS =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

const CHAR_TO_INDEX = new Map<string, number>();
for (let i = 0; i < CHARACTERS.length; i += 1) {
  CHAR_TO_INDEX.set(CHARACTERS[i], i);
}

const MINIMUM_SUPPLY = 5;

const STRUCTURES: Record<number, string> = {
  0: "Armory",
  1: "Barracks",
  2: "Bunker",
  3: "Command Center",
  4: "Engineering Bay",
  5: "Factory",
  6: "Fusion Core",
  7: "Ghost Academy",
  8: "Missile Turret",
  9: "Reactor (Barracks)",
  10: "Reactor (Factory)",
  11: "Reactor (Starport)",
  12: "Refinery",
  13: "Sensor Tower",
  14: "Starport",
  15: "Supply Depot",
  16: "Tech Lab (Barracks)",
  17: "Tech Lab (Factory)",
  18: "Tech Lab (Starport)",
  19: "Assimilator",
  20: "Cybernetics Core",
  21: "Dark Shrine",
  22: "Fleet Beacon",
  23: "Forge",
  24: "Gateway",
  25: "Nexus",
  26: "Photon Cannon",
  27: "Pylon",
  28: "Robotics Bay",
  29: "Robotics Facility",
  30: "Stargate",
  31: "Templar Archives",
  32: "Twilight Council",
  33: "Baneling Nest",
  34: "Evolution Chamber",
  35: "Extractor",
  36: "Hatchery",
  37: "Hydralisk Den",
  38: "Infestation Pit",
  39: "Nydus Network",
  40: "Roach Warren",
  41: "Spawning Pool",
  42: "Spine Crawler",
  43: "Spire",
  44: "Spore Crawler",
  45: "Ultralisk Cavern",
  46: "Creep Tumor"
};

const UNITS: Record<number, string> = {
  0: "Banshee",
  1: "Battlecruiser",
  2: "Ghost",
  3: "Hellion",
  4: "Marauder",
  5: "Marine",
  6: "Medivac",
  7: "Raven",
  8: "Reaper",
  9: "SCV",
  10: "Siege Tank",
  11: "Thor",
  12: "Viking",
  14: "Carrier",
  15: "Colossus",
  16: "Dark Templar",
  17: "High Templar",
  18: "Immortal",
  19: "Mothership",
  20: "Observer",
  21: "Phoenix",
  22: "Probe",
  23: "Sentry",
  24: "Stalker",
  25: "Void Ray",
  26: "Zealot",
  27: "Corruptor",
  28: "Drone",
  29: "Hydralisk",
  30: "Mutalisk",
  31: "Overlord",
  32: "Queen",
  33: "Roach",
  34: "Ultralisk",
  35: "Zergling",
  38: "Infestor",
  39: "Warp Prism",
  40: "Hellbat",
  41: "Warhound",
  42: "Widow Mine",
  43: "Mothership Core",
  44: "Oracle",
  45: "Tempest",
  46: "Swarm Host",
  47: "Viper",
  48: "Cyclone",
  49: "Liberator",
  50: "Disruptor",
  51: "Adept"
};

const MORPHS: Record<number, string> = {
  0: "Orbital Command",
  1: "Planetary Fortress",
  2: "Warp Gate",
  3: "Lair",
  4: "Hive",
  5: "Greater Spire",
  6: "Brood Lord",
  7: "Baneling",
  8: "Overseer",
  9: "Ravager",
  10: "Lurker",
  12: "Lurker Den",
  13: "Archon"
};

const UPGRADES: Record<number, string> = {
  0: "Terran Building Armor",
  1: "Terran Infantry Armor",
  2: "Terran Infantry Weapons",
  3: "Terran Ship Plating",
  4: "Terran Ship Weapons",
  5: "Terran Vehicle Plating",
  6: "Terran Vehicle Weapons",
  7: "250mm Strike Cannons",
  8: "Banshee - Cloaking",
  9: "Ghost - Cloaking",
  10: "Hellion - Pre-igniter",
  11: "Marine - Stimpack",
  12: "Raven - Seeker Missiles",
  13: "Siege Tank - Siege Tech",
  14: "Bunker - Neosteel Frame",
  15: "Marauder - Concussive Shells",
  16: "Marine - Combat Shields",
  17: "Reaper Speed",
  18: "Protoss Ground Armor",
  19: "Protoss Ground Weapons",
  20: "Protoss Air Armor",
  21: "Protoss Air Weapons",
  22: "Protoss Shields",
  23: "Sentry - Hallucination",
  24: "High Templar - Psi Storm",
  25: "Stalker - Blink",
  26: "Warp Gate Tech",
  27: "Zealot - Charge",
  28: "Zerg Ground Carapace",
  29: "Zerg Melee Weapons",
  30: "Zerg Flyer Carapace",
  31: "Zerg Flyer Weapons",
  32: "Zerg Missile Weapons",
  33: "Hydralisk - Grooved Spines",
  34: "Overlord - Pneumatized Carapace",
  35: "Overlord - Ventral Sacs",
  36: "Roach - Glial Reconstitution",
  38: "Roach - Tunneling Claws",
  40: "Ultralisk - Chitinous Plating",
  41: "Zergling - Adrenal Glands",
  42: "Zergling - Metabolic Boost",
  44: "Burrow",
  45: "Centrifugal Hooks",
  46: "Ghost - Moebius Reactor",
  47: "Extended Thermal Lance",
  49: "Neural Parasite",
  50: "Pathogen Gland",
  51: "Battlecruiser - Behemoth Reactor",
  52: "Battlecruiser - Weapon Refit",
  53: "Hi-Sec Auto Tracking",
  54: "Medivac - Caduceus Reactor",
  55: "Raven - Corvid Reactor",
  56: "Raven - Durable Materials",
  57: "Hellion - Transformation Servos",
  58: "Carrier - Graviton Catapult",
  59: "Observer - Gravitic Boosters",
  60: "Warp Prism - Gravitic Drive",
  61: "Oracle - Bosonic Core",
  62: "Tempest - Gravity Sling",
  64: "Swarm Host - Enduring Locusts",
  65: "Hydralisk - Muscular Augments",
  66: "Drilling Claws",
  67: "Anion Pulse-Crystals",
  68: "Flying Locusts",
  69: "Seismic Spines",
  71: "Targeting Optics",
  72: "Advanced Ballistics",
  73: "Resonating Glaives"
};

export interface SaltWrapper {
  buildId: string;
  source: string;
  payload: string;
}

/** Parse the Spawning Tool SALT wrapper: `$<buildId>|<source>||<payload>`. */
export function parseSaltWrapper(input: string): SaltWrapper | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^\$([^|]*)\|([^|]*)\|\|([\s\S]*)$/);
  if (!match) {
    return null;
  }
  return { buildId: match[1].trim(), source: match[2].trim(), payload: match[3] };
}

function saltName(type: number, id: number): string {
  switch (type) {
    case 0:
      return STRUCTURES[id] ?? "Unknown";
    case 1:
      return UNITS[id] ?? "Unknown";
    case 2:
      return MORPHS[id] ?? "Unknown";
    case 3:
      return UPGRADES[id] ?? "Unknown";
    default:
      return "Unknown";
  }
}

/** Convert a raw SALT name into this project's canonical action vocabulary. */
function saltNameToAction(name: string): string {
  // Add-ons: "Reactor (Barracks)" -> "Barracks Reactor".
  const addon = name.match(/^(Reactor|Tech Lab) \(([^)]+)\)$/);
  if (addon) {
    return `${addon[2]} ${addon[1]}`;
  }
  // Upgrades encoded as "Unit - Ability" -> keep the ability name.
  const dash = name.split(" - ");
  if (dash.length === 2) {
    return dash[1].trim();
  }
  const fixes: Record<string, string> = {
    "Warp Gate Tech": "Warp Gate",
    "Zerg Ground Carapace": "Zerg Ground Armor",
    "Reaper Speed": "Reaper Speed"
  };
  return fixes[name] ?? name;
}

export function decodeSalt(input: string): ParsedImport {
  const trimmed = input.trim();
  const tildeIndex = trimmed.indexOf("~");
  if (tildeIndex < 0) {
    throw new Error("Not a SALT string: missing the '~' step marker.");
  }

  const header = trimmed.slice(0, tildeIndex);
  const metaItems = header.slice(1).split("|");
  const title = (metaItems[0] ?? "").trim();
  const payload = trimmed.slice(tildeIndex + 1);

  const steps: ImportedStep[] = [];
  const warnings: string[] = [];

  for (let i = 0; i + 5 <= payload.length; i += 5) {
    const block = payload.slice(i, i + 5);
    const indices = Array.from(block).map((ch) => CHAR_TO_INDEX.get(ch));
    if (indices.some((value) => value === undefined)) {
      warnings.push(`Skipped unrecognized SALT block "${block}".`);
      continue;
    }
    const [supplyRaw, minute, second, type, id] = indices as number[];
    const rawName = saltName(type, id);
    if (rawName === "Unknown") {
      warnings.push(`Unknown SALT item (type ${type}, id ${id}) skipped.`);
      continue;
    }

    const normalized = normalizeAction(saltNameToAction(rawName));
    const supply = supplyRaw > 0 ? supplyRaw + MINIMUM_SUPPLY - 1 : undefined;
    const timeSeconds = minute * 60 + second;

    // SALT lists repeated units as separate blocks; coalesce identical
    // consecutive items at the same supply/time into a single counted step so
    // the output matches the project's "Nx Unit" convention.
    const previous = steps[steps.length - 1];
    if (
      previous &&
      previous.matchKey === normalized.matchKey &&
      previous.supply === supply &&
      previous.timeSeconds === timeSeconds &&
      !normalized.note
    ) {
      previous.count += 1;
      previous.action = `${previous.count}x ${normalized.action}`;
      continue;
    }

    steps.push({
      raw: block,
      action: normalized.action,
      matchKey: normalized.matchKey,
      count: normalized.count,
      note: normalized.note,
      time: `${minute}:${String(second).padStart(2, "0")}`,
      timeSeconds,
      supply,
      isWorker: normalized.isWorker,
      isSupplyStructure: normalized.isSupplyStructure
    });
  }

  if (steps.length === 0) {
    warnings.push("No build steps were decoded from the SALT string.");
  }

  const race = inferRace(steps.map((step) => step.matchKey));
  return {
    format: "salt",
    race,
    name: title.length > 0 ? title : undefined,
    steps,
    warnings
  };
}
