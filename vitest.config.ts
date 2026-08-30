import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: ["src/lib/persistence/firestoreEmulator.test.ts"],
    testTimeout: 10000,
    // This Windows workspace can exhaust fork startup when every jsdom suite
    // launches concurrently. Serial workers make the reported total reliable.
    maxWorkers: 1,
    pool: "threads",
  },
});
