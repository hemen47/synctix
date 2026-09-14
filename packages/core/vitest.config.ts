import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // M1 requires 90% on core. Reported per-file so one well-covered module cannot
      // mask an untested one.
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.types.ts", "src/index.ts"],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
})
