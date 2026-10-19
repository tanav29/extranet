import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/* The running Fastify server (npx extranet / npm start at the repo root). Used both as a dev
 * proxy so the admin/analytics pages work with hot reload, and as the host of
 * the finished bundle in public/app. */
const backend = process.env.VITE_BACKEND || "http://localhost:5050";

export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    /* ^ keys are RegExp contexts: forward runtime API traffic to the Fastify
     * server while everything else is served by Vite itself. */
    proxy: {
      "^/admin/(?:api|qr)(?:$|/)": { target: backend, changeOrigin: true },
      "^/fonts.css$": { target: backend, changeOrigin: true },
      "^/fonts/": { target: backend, changeOrigin: true },
      "^/favicon.ico$": { target: backend, changeOrigin: true },
      "^/robots.txt$": { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: "../public/app",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: path.resolve(__dirname, "admin.html"),
        browse: path.resolve(__dirname, "browse.html"),
        analytics: path.resolve(__dirname, "analytics.html"),
      },
    },
  },
});
