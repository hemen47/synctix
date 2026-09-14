import js from "@eslint/js"
import tseslint from "typescript-eslint"
import prettier from "eslint-config-prettier"

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "**/coverage/**", "vendor/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Domain failures are returned as Result, so an unused catch binding is normal.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // circuit-json's element union is wide; narrowing helpers legitimately take unknown.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // Service bootstraps, scripts, and the console logger itself legitimately write to
    // stdout. Everything else goes through @syntrix/shared's logger.
    files: [
      "apps/*/src/index.ts",
      "apps/web/server.js",
      "scripts/**",
      "packages/shared/src/logger.ts",
    ],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
)
