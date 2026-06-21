import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { loadConfig, loadInitialData } from "./src/core/loader";
import { runImport } from "./src/core/import/service";
import { setBranchDisabled } from "./src/core/branch-state/service";
import type { ImportPreviewRequest } from "./src/core/import/types";
import type { SetBranchDisabledRequest } from "./src/core/branch-state/types";

function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body.length > 0 ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function buildGraphApiPlugin(): Plugin {
  return {
    name: "build-graph-api",
    configureServer(server) {
      server.middlewares.use("/api/graphs", (_req, res) => {
        try {
          const data = loadInitialData();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });

      server.middlewares.use("/api/import", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          res.setHeader("Content-Type", "application/json");
          try {
            const requestBody = (await readJsonBody(req)) as ImportPreviewRequest;
            const config = loadConfig();
            const buildsPath = path.resolve(process.cwd(), config.data.buildsPath);
            const result = runImport(buildsPath, requestBody);
            res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        })();
      });

      server.middlewares.use("/api/set-branch-disabled", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          res.setHeader("Content-Type", "application/json");
          try {
            const requestBody = (await readJsonBody(req)) as SetBranchDisabledRequest;
            const config = loadConfig();
            const buildsPath = path.resolve(process.cwd(), config.data.buildsPath);
            const result = setBranchDisabled(buildsPath, requestBody);
            res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        })();
      });
    }
  };
}

export default defineConfig({
  plugins: [buildGraphApiPlugin()],
  server: {
    port: 5174,
    open: "/viewer.html"
  }
});
