import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBackup, hadUncleanShutdown, markSession, migrateLegacyLayout, restoreBackup } from "../../desktop/dataLifecycle";
import { evaluateUpdatePolicy } from "../../desktop/updatePolicy";

describe("desktop productization", () => {
  it("migrates non-destructively and restores user data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-life-")); const legacy = path.join(root, "app"); const data = path.join(root, "user");
    fs.mkdirSync(path.join(legacy, "data"), { recursive: true }); fs.writeFileSync(path.join(legacy, "data", "sample.json"), "ok");
    expect(migrateLegacyLayout(legacy, data).migrated).toContain("data"); expect(fs.existsSync(path.join(legacy, "data", "sample.json"))).toBe(true);
    fs.writeFileSync(path.join(data, "value.txt"), "before"); const backup = createBackup(data); fs.writeFileSync(path.join(data, "value.txt"), "after"); restoreBackup(data, backup);
    expect(fs.readFileSync(path.join(data, "value.txt"), "utf8")).toBe("before");
  });
  it("tracks crash state and fails closed on unsigned updates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-life-")); markSession(root, false); expect(hadUncleanShutdown(root)).toBe(true); markSession(root, true); expect(hadUncleanShutdown(root)).toBe(false);
    expect(evaluateUpdatePolicy({ packaged: true, signedRelease: false, updateUrl: "https://updates.example" }).enabled).toBe(false);
    expect(evaluateUpdatePolicy({ packaged: true, signedRelease: true, updateUrl: "https://updates.example", platform: "win32" }).enabled).toBe(true);
  });
});
