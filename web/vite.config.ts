/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API runs separately in development; proxying keeps everything same-origin.
    proxy: { "/api": "http://localhost:4000" },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Two library chunks: the charts (only the pages with charts load them) and everything else.
        // Each library is named explicitly: Rollup otherwise moves a shared one (clsx) into the first
        // chunk that uses it, and the first screen would load the charts.
        manualChunks(id) {
          if (/node_modules\/(recharts|recharts-scale|react-smooth|lodash|d3-[a-z-]+|victory-vendor|internmap|decimal\.js-light|eventemitter3|tiny-invariant|fast-equals|react-transition-group|dom-helpers)\//.test(id)) return "charts";
          if (id.includes("node_modules/") || id.includes("commonjsHelpers")) return "react";
        },
      },
    },
  },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
});
