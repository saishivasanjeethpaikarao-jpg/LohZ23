import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVerifiedAuthMiddleware } from "../../../server/authMiddleware";
import { registerSelfCodingRoutes } from "../../../server/selfCoding";
import { CodeChangeProposalEngine } from "./engine";
import { ControlledRepository } from "./repository";
import type { SandboxExecutor } from "./sandbox";
import { InMemorySelfCodingStore } from "./store";

const roots: string[] = []; const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-phase43-http-")); roots.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}"); fs.writeFileSync(path.join(root, ".env"), "SECRET=x");
  fs.writeFileSync(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  const repository = new ControlledRepository(root);
  const sandbox: SandboxExecutor = { verify: async (_patches, checks) => checks.map((check) => ({ check, passed: true, exitCode: 0, durationMs: 1, output: "ok" })) };
  const engine = new CodeChangeProposalEngine({ repository, store: new InMemorySelfCodingStore(), sandbox });
  const app = express(); app.use(express.json());
  app.use("/api", createVerifiedAuthMiddleware(async (token) => token === "admin" ? "admin-a" : token === "user" ? "user-b" : Promise.reject(new Error("bad token"))) as never);
  registerSelfCodingRoutes(app, { engine, repository, isAdmin: (uid) => uid === "admin-a" });
  const server = http.createServer(app); servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("listen failed");
  const request = (url: string, token: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${url}`, {
    ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { request, repository };
}

describe("Phase 43 authenticated administration contract", () => {
  it("denies ordinary authenticated users and never exposes .env", async () => {
    const { request } = await setup();
    expect((await request("/api/self-coding/inspect/file?path=src/value.ts", "user")).status).toBe(403);
    expect((await request("/api/self-coding/inspect/file?path=.env", "admin")).status).toBe(404);
    expect((await request("/api/self-coding/inspect/file?path=../outside", "admin")).status).toBe(404);
  });

  it("rejects malformed patch JSON and derives an auditable proposal for valid input", async () => {
    const { request, repository } = await setup(); const hash = repository.readSource("src/value.ts")!.reference.sha256;
    const malformed = await request("/api/self-coding/proposals", "admin", { method: "POST", body: JSON.stringify({ kind: "feature", title: "x", reason: "x", requirement: "x", patches: [{ nope: true }], tests: ["x"] }) });
    expect(malformed.status).toBe(400);
    const valid = await request("/api/self-coding/proposals", "admin", { method: "POST", body: JSON.stringify({
      proposalId: "value-change", kind: "feature", title: "Change value", reason: "requested", requirement: "Change exported value",
      patches: [
        { path: "src/value.ts", operation: "update", expectedSha256: hash, hunks: [{ oldText: "value = 1", newText: "value = 2" }] },
        { path: "src/value.test.ts", operation: "create", expectedSha256: null, hunks: [{ oldText: "", newText: 'import { it } from "vitest";\nit("works", () => {});\n' }] },
      ], tests: ["exported value equals 2"],
    }) });
    expect(valid.status).toBe(201);
    const created = await valid.json() as { status: string; proposalDigest: string };
    expect(created.status).toBe("proposed"); expect(created.proposalDigest).toMatch(/^[a-f0-9]{64}$/);
    const audit = await request("/api/self-coding/proposals/value-change/audit", "admin");
    expect((await audit.json() as { events: unknown[] }).events).toHaveLength(1);
  });

  it("requires explicit apply acknowledgement even after approval", async () => {
    const { request, repository } = await setup(); const hash = repository.readSource("src/value.ts")!.reference.sha256;
    const body = { proposalId: "apply-gate", kind: "feature", title: "Change", reason: "request", requirement: "Change value",
      patches: [
        { path: "src/value.ts", operation: "update", expectedSha256: hash, hunks: [{ oldText: "value = 1", newText: "value = 2" }] },
        { path: "src/value.test.ts", operation: "create", expectedSha256: null, hunks: [{ oldText: "", newText: 'import { it } from "vitest";\nit("works", () => {});\n' }] },
      ], tests: ["value test"] };
    await request("/api/self-coding/proposals", "admin", { method: "POST", body: JSON.stringify(body) });
    await request("/api/self-coding/proposals/apply-gate/versions/1/verify", "admin", { method: "POST", body: "{}" });
    const approvalRequest = await (await request("/api/self-coding/proposals/apply-gate/versions/1/request-approval", "admin", { method: "POST", body: "{}" })).json() as { approvalRequestId: string };
    await request("/api/self-coding/proposals/apply-gate/versions/1/approve", "admin", { method: "POST", body: JSON.stringify({ approved: true, approvalRequestId: approvalRequest.approvalRequestId }) });
    expect((await request("/api/self-coding/proposals/apply-gate/versions/1/apply", "admin", { method: "POST", body: "{}" })).status).toBe(400);
    expect(repository.readSource("src/value.ts")?.content).toContain("value = 1");
  });
});
