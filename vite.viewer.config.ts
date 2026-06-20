import { defineConfig, type Plugin } from "vite";
import { loadInitialData } from "./src/core/loader";

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
