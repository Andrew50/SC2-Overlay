import type { ImportedStep, ParsedImport } from "./types";
import { normalizeAction, inferRace } from "./normalize";
import { formatSeconds, isIntegerToken, isTimeToken, parseTimeToSeconds } from "./util";

const HEADER_NOISE = [
  /^get salt encoding/i,
  /^build order$/i,
  /^description$/i,
  /^comments?\b/i,
  /^details$/i,
  /^hide timestamps/i,
  /^color code types/i,
  /^workers? army buildings/i,
  /^view real time/i,
  /^export as new/i,
  /^return to build/i,
  /^spawning tool/i,
  /^created by/i,
  /^published on/i,
  /^modified on/i,
  /^patch:/i,
  /^difficulty:/i,
  /^votes?\b/i,
  /^favorite$/i
];

/**
 * Parse a Spawning Tool style build order. Accepts both the markdown table form
 * copied from the site (`| 14 | 0:14 | Extractor |`) and plain `14 Action` /
 * `0:14 Action` lines.
 */
export function parseSpawningToolText(text: string): ParsedImport {
  const warnings: string[] = [];
  const steps: ImportedStep[] = [];
  const lines = text.split(/\r?\n/);
  let name: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^[-|:\s]+$/.test(line)) {
      continue; // markdown table separators
    }
    if (HEADER_NOISE.some((re) => re.test(line))) {
      continue;
    }
    // Markdown heading -> candidate build name.
    const heading = line.match(/^#+\s+(.*)$/);
    if (heading) {
      if (!name) {
        name = heading[1].trim();
      }
      continue;
    }

    const cells = extractCells(line);
    if (!cells) {
      continue;
    }
    const parsed = parseCells(cells, rawLine);
    if (!parsed) {
      if (looksLikeStep(cells)) {
        warnings.push(`Could not parse line: "${line}"`);
      }
      continue;
    }
    if (!parsed.confident) {
      warnings.push(`Unrecognized action "${parsed.step.action}" (kept as-is): "${line}"`);
    }
    steps.push(parsed.step);
  }

  if (steps.length === 0) {
    warnings.push("No build steps were parsed from the input.");
  }

  const race = inferRace(steps.map((step) => step.matchKey));
  return { format: "spawningtool-text", race, name, steps, warnings };
}

function extractCells(line: string): string[] | null {
  if (line.includes("|")) {
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    return cells.length > 0 ? cells : null;
  }
  const tokens = line.split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? [line.trim()] : null;
}

function looksLikeStep(cells: string[]): boolean {
  const joined = cells.join(" ");
  return /\d/.test(joined) && /[a-zA-Z]/.test(joined);
}

function parseCells(cells: string[], rawLine: string): { step: ImportedStep; confident: boolean } | null {
  let supply: number | undefined;
  let time: string | undefined;
  let actionText: string | undefined;

  if (cells.length > 1) {
    // Table form: each cell is supply / time / action.
    for (const cell of cells) {
      if (supply === undefined && isIntegerToken(cell)) {
        supply = Number(cell);
        continue;
      }
      if (time === undefined && isTimeToken(cell)) {
        time = cell.trim();
        continue;
      }
      if (actionText === undefined) {
        actionText = cell;
      } else {
        actionText = `${actionText} ${cell}`;
      }
    }
  } else {
    // Single cell: leading supply/time tokens then the action remainder.
    const tokens = cells[0].split(/\s+/).filter(Boolean);
    let cursor = 0;
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (supply === undefined && isIntegerToken(token)) {
        supply = Number(token);
        cursor += 1;
        continue;
      }
      if (time === undefined && isTimeToken(token)) {
        time = token;
        cursor += 1;
        continue;
      }
      break;
    }
    actionText = tokens.slice(cursor).join(" ");
  }

  if (!actionText || actionText.trim().length === 0) {
    return null;
  }

  const normalized = normalizeAction(actionText);
  const timeSeconds = parseTimeToSeconds(time);
  const normalizedTime = timeSeconds !== undefined ? formatSeconds(timeSeconds) : time;

  return {
    step: {
      raw: rawLine.trim(),
      action: normalized.action,
      matchKey: normalized.matchKey,
      count: normalized.count,
      note: normalized.note,
      time: normalizedTime,
      timeSeconds,
      supply,
      isWorker: normalized.isWorker,
      isSupplyStructure: normalized.isSupplyStructure
    },
    confident: normalized.confident
  };
}
