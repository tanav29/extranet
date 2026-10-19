import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
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
