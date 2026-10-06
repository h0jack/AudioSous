import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Whole-mix planning runs every planner several times; a slow CI runner needs more than the 5 s default.
    testTimeout: 30_000,
  },
});
