import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CompactBuildFile } from "../src/core/types";
import { importBuildOrder, renderMergeDiff, type OpponentRace } from "../src/core/import";

interface CliArgs {
  file?: string;
  text?: string;
  into?: string;
  race?: OpponentRace;
  name?: string;
  out?: string;
  apply: boolean;
  timeToleranceSec?: number;
  supplyTolerance?: number;
  keepWorkers: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { apply: false, keepWorkers: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--file":
      case "-f":
        args.file = next();
        break;
      case "--text":
        args.text = next();
        break;
      case "--into":
      case "-i":
        args.into = next();
        break;
      case "--race":
        args.race = next() as OpponentRace;
        break;
      case "--name":
        args.name = next();
        break;
      case "--out":
      case "-o":
        args.out = next();
        break;
      case "--apply":
        args.apply = true;
        break;
      case "--keep-workers":
        args.keepWorkers = true;
        break;
      case "--time-tolerance":
        args.timeToleranceSec = Number(next());
        break;
      case "--supply-tolerance":
        args.supplyTolerance = Number(next());
        break;
      default:
        if (!args.file && !arg.startsWith("-")) {
          args.file = arg;
        }
        break;
    }
  }
  return args;
}

function usage(): never {
  console.error(
    [
      "Usage: npm run import-build -- --into <compact.json> (--file <build.txt> | --text \"...\") [options]",
      "",
      "Options:",
      "  --into, -i <path>       Target compact build file to merge into (required)",
      "  --file, -f <path>       Build order file to import (Spawning Tool text)",
      "  --text \"...\"            Build order text passed inline",
      "  --race <r>              Force race (terran|zerg|protoss); inferred otherwise",
      "  --name <name>           Display name for the imported build",
      "  --out, -o <path>        Write the proposed patched file here (dry run)",
      "  --apply                 Overwrite the target file with the merged result",
      "  --keep-workers          Keep worker units in generated steps",
      "  --time-tolerance <s>    Seconds of timing slack when matching (default 3)",
      "  --supply-tolerance <n>  Supply slack when matching (default 1)"
    ].join("\n")
  );
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.into || (!args.file && !args.text)) {
    usage();
  }

  const targetPath = path.resolve(process.cwd(), args.into);
  const targetBuildId = path.basename(targetPath).replace(/\.json$/i, "");
  const compact = JSON.parse(readFileSync(targetPath, "utf8")) as CompactBuildFile;

  const input = args.text ?? readFileSync(path.resolve(process.cwd(), args.file as string), "utf8");

  const result = importBuildOrder(compact, input, {
    targetBuildId,
    race: args.race,
    importName: args.name,
    outputSkipWorkers: !args.keepWorkers,
    timeToleranceSec: args.timeToleranceSec,
    supplyTolerance: args.supplyTolerance
  });

  const { parsed, plan, validationErrors } = result;

  console.log("=== Parsed import ===");
  console.log(`Format: ${parsed.format}`);
  console.log(`Race: ${parsed.race ?? args.race ?? "(unknown)"}`);
  console.log(`Name: ${parsed.name ?? "(none)"}`);
  console.log(`Steps parsed: ${parsed.steps.length}`);
  if (parsed.warnings.length > 0) {
    console.log("Parser warnings:");
    parsed.warnings.forEach((w) => console.log(`  - ${w}`));
  }

  console.log("\n=== Merge plan ===");
  console.log(`Strategy: ${plan.action}`);
  console.log(`New branch: ${plan.newBranchId}`);
  if (plan.match) {
    console.log(
      `Matched ${plan.match.matchedStepCount} step(s); diverges at "${plan.match.divergeNodeId}" step ${plan.match.divergeStepIndex}`
    );
  } else {
    console.log("No shared prefix found; branching at the race root.");
  }
  if (plan.warnings.length > 0) {
    console.log("Plan warnings:");
    plan.warnings.forEach((w) => console.log(`  - ${w}`));
  }

  console.log("\n=== Diff ===");
  console.log(renderMergeDiff(plan.diff));

  if (validationErrors.length > 0) {
    console.error("\n=== Validation FAILED (patch not written) ===");
    validationErrors.forEach((e) => console.error(`  - ${e}`));
    process.exit(2);
  }
  console.log("\nValidation: OK");

  const serialized = `${JSON.stringify(plan.patchedCompact, null, 2)}\n`;

  if (args.out) {
    const outPath = path.resolve(process.cwd(), args.out);
    writeFileSync(outPath, serialized, "utf8");
    console.log(`\nProposed patch written to ${outPath} (dry run; target unchanged).`);
  }

  if (args.apply) {
    writeFileSync(targetPath, serialized, "utf8");
    console.log(`\nApplied merge to ${targetPath}. Run \`npm run validate:data\` to confirm global integrity.`);
  } else if (!args.out) {
    console.log("\nDry run only. Re-run with --apply to write the merge, or --out <path> to save the patch.");
  }
}

try {
  main();
} catch (error) {
  console.error("Import failed.");
  console.error((error as Error).message);
  process.exit(1);
}
