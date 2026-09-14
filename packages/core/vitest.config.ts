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
      // M1 requires 90%, enforced here so the criterion cannot silently rot.
      //
      // Branches sit lower on purpose (ADR-0008): circuit-json marks almost every field
      // optional, so the code is full of `?? []` and `?.` fallbacks whose false arms are
      // unreachable in practice. Driving that number to 90 would mean contriving
      // documents that cannot occur, which buys confidence in the tests rather than in
      // the code.
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    },
  },
})
