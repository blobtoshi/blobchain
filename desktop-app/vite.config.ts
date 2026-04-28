import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import path from "node:path";

// Electron loads via file:// — base must be relative.
export default defineConfig({
  base: "./",
  // The website's .env (with VITE_SUPABASE_URL etc.) lives one level up.
  // Without this, Vite can't find it and the bundle ships with empty
  // env vars, causing "supabaseUrl is required" at runtime in Electron.
  envDir: path.resolve(__dirname, ".."),
  plugins: [
    react(),
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  resolve: {
    alias: {
      // Both aliases point at the website source so shared components import
      // either via `@web/...` (desktop convention) or `@/...` (website convention).
      "@web": path.resolve(__dirname, "../src"),
      "@": path.resolve(__dirname, "../src"),
    },
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    strictPort: true,
  },
});
