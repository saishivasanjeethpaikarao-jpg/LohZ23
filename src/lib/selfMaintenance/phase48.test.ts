import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticEngine } from "./diagnosticEngine";
import { HealthMonitor, InMemoryHealthHistoryStore } from "./healthMonitor";
import { RepositoryInspector } from "./repositoryInspector";
import { VerificationEngine } from "./verificationEngine";
import { autonomyAllows, classifyRisk } from "./policy";
import { LocalMaintenanceHistoryStore, newMaintenanceRecord } from "./maintenanceStore";
import { ControlledGitIntegration } from "./gitIntegration";

describe("Phase 48 self-maintenance safety", () => {
  it("never turns unknown checks into healthy status", async () => {
    const history = new InMemoryHealthHistoryStore();
    const monitor = new HealthMonitor([{ id: "probe", subsystem: "persistence", category: "Persistence", run: async () => ({ status: "UNKNOWN", score: null, confidence: null, checkedAt: Date.now(), checksPerformed: ["probe"], failures: [], warnings: ["not_configured"], evidence: [], dependencies: [] }) }], history);
    const snapshot = await monitor.run("lightweight");
    expect(snapshot.status).toBe("UNKNOWN"); expect(snapshot.overallScore).toBeNull(); expect((await monitor.historyList()).length).toBe(1);
  });

  it("records deterministic, uncertainty-aware diagnoses", () => {
    const result = new DiagnosticEngine().diagnose({ incidentId: "inc-1", subsystem: "Windows Agent", symptom: "agent unavailable", evidence: [{ source: "socket", detail: "loopback connection refused", authoritative: true }] });
    expect(result.incidentId).toBe("inc-1"); expect(result.probableCauses[0].confidence).toBe("MEDIUM"); expect(result.recommendedInvestigation.length).toBeGreaterThan(0);
  });

  it("keeps repository inspection bounded and rejects traversal", () => {
    const inspector = new RepositoryInspector(process.cwd());
    expect(inspector.listFiles()).not.toContain(".env"); expect(inspector.readFile("../.env")).toBeNull(); expect(inspector.search("CognitiveCore").length).toBeGreaterThan(0); expect(inspector.packageManifest()?.name).toBe("lohz");
  });

  it("classifies protected paths as critical and keeps default autonomy below promotion", () => {
    expect(classifyRisk(["src/credentialStore.ts"])).toBe("CRITICAL"); expect(classifyRisk(["src/lib/example.ts"])).toBe("LOW"); expect(autonomyAllows(2, "LOW")).toBe(false); expect(autonomyAllows(5, "LOW")).toBe(true); expect(autonomyAllows(5, "HIGH")).toBe(false);
  });

  it("detects health regressions instead of accepting compilation alone", () => {
    const engine = new VerificationEngine();
    const before = { snapshotId: "a", generatedAt: 1, mode: "standard" as const, overallScore: 95, status: "HEALTHY" as const, subsystems: [{ subsystem: "core", category: "Core", weight: 1, status: "HEALTHY" as const, score: 95, confidence: 1, checkedAt: 1, checksPerformed: [], failures: [], warnings: [], evidence: [], dependencies: [] }] };
    const after = { ...before, snapshotId: "b", generatedAt: 2, overallScore: 80, subsystems: [{ ...before.subsystems[0], status: "DEGRADED" as const, score: 80 }] };
    expect(engine.compareHealth(before, after).passed).toBe(false); expect(engine.compareHealth(before, after).regressions.length).toBe(1);
  });

  it("persists maintenance records with owner isolation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lohz-maint-")); const store = new LocalMaintenanceHistoryStore(root); const diagnosis = new DiagnosticEngine().diagnose({ subsystem: "core", symptom: "failure" });
    const record = newMaintenanceRecord("user-a", diagnosis); expect(await store.append(record)).toBe(true); expect((await store.list("user-a")).length).toBe(1); expect((await store.list("user-b")).length).toBe(0);
  });

  it("does not run Git commands without explicit approval or safe paths", async () => {
    const calls: string[][] = []; const git = new ControlledGitIntegration(process.cwd(), async (_cwd, args) => { calls.push(args); return { code: 0, output: "ok" }; });
    expect((await git.commitApproved({ approved: false, incidentId: "inc", proposalId: "p", files: ["src/a.ts"] })).committed).toBe(false);
    expect((await git.commitApproved({ approved: true, incidentId: "inc", proposalId: "p", files: ["../secret"] })).committed).toBe(false);
    expect((await git.commitApproved({ approved: true, incidentId: "inc", proposalId: "p", files: ["src/a.ts"] })).committed).toBe(true); expect(calls[1][0]).toBe("commit");
    expect((await git.rollback("bad sha", false)).rolledBack).toBe(false);
  });
});
