import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained trainer.html (scripts and styles inlined, no CDN), so it can be
// uploaded to the device's /html folder as a single file (scripts/gzip.mjs adds .gz).
//
// For development, DEVICE=http://<device-ip> npm run dev (or vite preview) proxies the
// device API, so the page behaves as if the device served it.
const device = process.env.DEVICE;
const proxy = device
  ? Object.fromEntries(["/fileserver", "/statusflow", "/json", "/info", "/upload", "/delete", "/reboot"].map((p) => [p, { target: device, changeOrigin: true }]))
  : undefined;

export default defineConfig({
  plugins: [viteSingleFile()],
  server: { proxy },
  preview: { proxy },
  build: {
    target: "es2020",
    outDir: "dist",
    rollupOptions: { input: "index.html" },
    chunkSizeWarningLimit: 4000,
  },
});
