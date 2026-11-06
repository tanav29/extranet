import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/* The reverse proxy (npm start at the repo root, listening on :8787). Used both
 * as a dev proxy so the admin/analytics pages work with hot reload, and as the
 * host of the finished bundle in app/dist (through the web service). */
const backend = process.env.VITE_BACKEND || "http://localhost:8787";

export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    /* ^ keys are RegExp contexts: forward runtime API traffic to the reverse
     * proxy while everything else is served by Vite itself. */
    proxy: {
      "^/api(?:$|/)": { target: backend, changeOrigin: true },
      "^/favicon.ico$": { target: backend, changeOrigin: true },
      "^/robots.txt$": { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: path.resolve(__dirname, "admin.html"),
        browse: path.resolve(__dirname, "browse.html"),
        analytics: path.resolve(__dirname, "analytics.html"),
        home: path.resolve(__dirname, "home.html"),
      },
    },
  },
});
