import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./packages/web/src"),
      "virtual:pwa-register/react": path.resolve(
        __dirname,
        "./packages/web/test/helpers/virtual-pwa-register-react.ts",
      ),
    },
  },
  test: {
    environmentMatchGlobs: [["packages/web/test/**", "jsdom"]],
    setupFiles: ["./packages/web/test/helpers/setup.ts"],
    include: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test.tsx", "test/**/*.test.ts"],
  },
});
