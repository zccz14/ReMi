import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./packages/web/src"),
    },
  },
  test: {
    environmentMatchGlobs: [["packages/web/test/**", "jsdom"]],
    setupFiles: ["./packages/web/test/helpers/setup.ts"],
    include: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test.tsx", "test/**/*.test.ts"],
  },
});
