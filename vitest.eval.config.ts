import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `npm run eval:ai`: the Copilot evaluation. Separate from `npm test` because it calls
// OpenAI and resets the demo database.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/eval/**/*.eval.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
