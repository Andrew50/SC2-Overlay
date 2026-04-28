import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();

function readJson(relativePath: string): unknown {
  const fullPath = path.resolve(ROOT_DIR, relativePath);
  return JSON.parse(readFileSync(fullPath, "utf8"));
}

export const configSchema = readJson("schemas/config.schema.json");
export const buildSchema = readJson("schemas/build.schema.json");
