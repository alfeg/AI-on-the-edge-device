import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained trainer.html (scripts and styles inlined, no CDN), so it can be
// uploaded to the device's /html folder as a single file (scripts/gzip.mjs adds .gz).
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: "es2020",
    outDir: "dist",
    rollupOptions: { input: "index.html" },
    chunkSizeWarningLimit: 4000,
  },
});
