import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { validateToolArgs } from "./lib/execution/guards";
import { isPublicHostname, resolveSafePath } from "../windows-agent/utils/validation";

const originalWorkspace = process.env.LOHZ_WORKSPACE;
const tempDirs: string[] = [];
afterEach(() => {
  if (originalWorkspace === undefined) delete process.env.LOHZ_WORKSPACE;
  else process.env.LOHZ_WORKSPACE = originalWorkspace;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Windows Agent boundary validation", () => {
  it("rejects private/local URL targets at the shared registry boundary", () => {
    for (const url of ["http://127.0.0.1/admin", "http://10.0.0.2", "http://192.168.1.5", "http://localhost", "http://service.local"]) {
      expect(validateToolArgs("openUrl", { url }).ok, url).toBe(false);
    }
    expect(validateToolArgs("openUrl", { url: "https://example.com/path" }).ok).toBe(true);
    expect(isPublicHostname("8.8.8.8")).toBe(true);
  });

  it("applies app allowlists and rename basename rules in the registry", () => {
    expect(validateToolArgs("openApp", { name: "chrome" }).ok).toBe(true);
    expect(validateToolArgs("openApp", { name: "arbitrary.exe" }).ok).toBe(false);
    expect(validateToolArgs("renameFile", { path: "notes.txt", newName: "../escape.txt" }).ok).toBe(false);
  });

  it("rejects a junction that escapes the configured workspace", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-path-safety-"));
    tempDirs.push(base);
    const workspace = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, "escape"), "junction");
    process.env.LOHZ_WORKSPACE = workspace;

    expect(resolveSafePath("safe.txt").ok).toBe(true);
    expect(resolveSafePath("escape/secret.txt")).toMatchObject({ ok: false, errorCode: "PATH_LINK_ESCAPE" });
  });
});
