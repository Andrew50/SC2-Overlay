import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        viewer: "viewer.html"
      }
    }
  },
  plugins: [
    electron({
      main: {
        entry: "electron/main.ts"
      },
      preload: {
        input: "electron/preload.ts"
      }
    })
  ]
});
