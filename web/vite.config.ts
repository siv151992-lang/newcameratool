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
      output: { manualChunks: { react: ["react", "react-dom", "react-router-dom", "@tanstack/react-query"], charts: ["recharts"] } },
    },
  },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
});
