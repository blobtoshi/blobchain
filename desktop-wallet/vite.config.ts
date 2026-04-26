import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

// Electron loads via file:// — base must be relative.
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@web": path.resolve(__dirname, "../src"),
    },
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
