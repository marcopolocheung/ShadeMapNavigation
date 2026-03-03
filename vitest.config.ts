import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/lib/__tests__/**/*.test.ts"],
  },
});
