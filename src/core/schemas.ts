import { readFileSync } from "node:fs";
import path from "node:path";

function resolveRootDir(): string {
  const schemaRoot = process.env.SC2_OVERLAY_SCHEMA_ROOT?.trim();
  if (schemaRoot) {
    return path.resolve(schemaRoot);
  }
  const envRoot = process.env.SC2_OVERLAY_APP_ROOT?.trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }
  return process.cwd();
}

function readJson(relativePath: string): unknown {
  const fullPath = path.resolve(resolveRootDir(), relativePath);
  return JSON.parse(readFileSync(fullPath, "utf8"));
}

export function loadSchemas(): { configSchema: unknown; buildSchema: unknown } {
  return {
    configSchema: readJson("schemas/config.schema.json"),
    buildSchema: readJson("schemas/build.schema.json")
  };
}
