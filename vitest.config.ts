import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/authorization.ts", "src/modules/artists/**/*.ts", "src/modules/tracks/**/*.ts", "src/modules/podcasts/**/*.ts", "src/modules/releases/**/*.ts"],
    },
  },
});
