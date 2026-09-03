import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: ["src/lib/persistence/firestoreEmulator.test.ts"],
    // selfCoding/repair and execution/sessionCoordinator have deep node:fs
    // import chains that take >10 s to JIT on Windows — raise ceiling.
    testTimeout: 30000,
    // This Windows workspace can exhaust thread-worker startup when heavy
    // node:fs suites are loaded concurrently. forks pool is slower to start
    // but does not timeout on large import graphs (verified: all 36 affected
    // tests pass under --pool=forks).
    maxWorkers: 1,
    pool: "forks",
  },
});
