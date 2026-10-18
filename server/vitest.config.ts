import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    globalSetup: ["test/globalSetup.ts"],
    // DB-backed suites share one test database, so run files sequentially.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
