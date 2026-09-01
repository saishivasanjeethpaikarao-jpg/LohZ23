import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { CredentialStore } from "./credentialStore";
import { isCredentialAdmin } from "../server/credentialAccess";

const dirs: string[] = [];
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-creds-"));
  dirs.push(dir);
  return { dir, store: new CredentialStore({ keyFile: path.join(dir, "key"), credentialsFile: path.join(dir, "credentials") }) };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("CredentialStore", () => {
  it("serializes concurrent provider updates without losing either secret", async () => {
    const { store } = makeStore();
    await Promise.all([store.setCredential("gemini", "gemini-secret"), store.setCredential("nvidia", "nvidia-secret")]);
    expect(await store.getCredential("gemini")).toBe("gemini-secret");
    expect(await store.getCredential("nvidia")).toBe("nvidia-secret");
  });

  it("fails closed for corrupt keys and encrypted files", async () => {
    const first = makeStore();
    fs.writeFileSync(path.join(first.dir, "key"), "short");
    await expect(first.store.init()).rejects.toThrow("32 bytes");
    const second = makeStore();
    await second.store.init();
    fs.writeFileSync(path.join(second.dir, "credentials"), "not-json");
    await expect(second.store.getCredential("gemini")).rejects.toThrow();
  });

  it("rejects provider-name injection and requires an explicit admin UID", async () => {
    const { store } = makeStore();
    await expect(store.getCredential("../../PATH")).rejects.toThrow("Invalid");
    expect(isCredentialAdmin("user-a", "user-a,user-b")).toBe(true);
    expect(isCredentialAdmin("attacker", "user-a,user-b")).toBe(false);
    expect(isCredentialAdmin("user-a", undefined)).toBe(false);
  });
});
