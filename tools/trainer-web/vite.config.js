import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained trainer.html (scripts and styles inlined, no CDN), so it can be
// uploaded to the device's /html folder as a single file (scripts/gzip.mjs adds .gz).
//
// For development, DEVICE=http://<device-ip> npm run dev (or vite preview) proxies the
// device API, so the page behaves as if the device served it.
const device = process.env.DEVICE;
// The ESP32's HTTP server rejects large request headers (431, or a reset connection), and a
// browser on localhost sends the cookies of every other local app: forward only what the
// device API needs.
const KEEP = new Set(["host", "content-type", "content-length", "accept", "connection"]);
const slimHeaders = (proxyServer) => proxyServer.on("proxyReq", (req) => {
  for (const h of req.getHeaderNames()) if (!KEEP.has(h)) req.removeHeader(h);
});
const proxy = device
  ? Object.fromEntries(["/fileserver", "/statusflow", "/json", "/info", "/upload", "/delete", "/reboot"]
    .map((p) => [p, { target: device, changeOrigin: true, configure: slimHeaders }]))
  : undefined;

export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  // components use <script setup> only: leave the Options API out of the bundle
  define: { __VUE_OPTIONS_API__: false, __VUE_PROD_DEVTOOLS__: false, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false },
  server: { proxy },
  preview: { proxy },
  build: {
    target: "es2020",
    outDir: "dist",
    rollupOptions: { input: "index.html" },
    chunkSizeWarningLimit: 4000,
  },
});
