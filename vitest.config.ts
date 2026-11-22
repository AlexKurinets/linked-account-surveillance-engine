import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // DB-backed files share one test database, so they run one at a time
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
