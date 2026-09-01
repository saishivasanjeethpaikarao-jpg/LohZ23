import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 44 production wiring", () => {
  const server = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
  const routes = fs.readFileSync(path.join(process.cwd(), "server", "selfCoding.ts"), "utf8");
  const repair = fs.readFileSync(path.join(process.cwd(), "src", "lib", "selfCoding", "repairEngine.ts"), "utf8");

  it("reuses the Phase 43 repository, store, sandbox, and proposal engine", () => {
    expect(server).toContain("new AutonomousRepairEngine");
    expect(server).toContain("repository: controlledRepository, store: selfCodingStore");
    expect(server).toContain("proposals: codeChangeProposalEngine, sandbox: fixedSandbox");
  });

  it("keeps all repair routes behind API authentication and credential-admin authorization", () => {
    expect(server.indexOf('app.use("/api", authMiddleware')).toBeLessThan(server.indexOf("registerSelfCodingRoutes(app"));
    expect(routes).toContain('app.use("/api/self-coding"');
    expect(routes).toContain("Self-coding administrator access required");
    expect(routes).toContain('/bugs/:incidentId/candidate');
    expect(routes).toContain('/bugs/:incidentId/finalize');
  });

  it("monitors provider, execution, runtime, and health outcomes", () => {
    expect(server).toContain("repairMonitor as BugSignalMonitor");
    expect(server).toContain("repairMonitor.execution");
    expect(server).toContain('repairMonitor.record(userId, "runtime_error"');
    expect(server).toContain("repairMonitor.observeHealth(snapshot)");
  });

  it("cannot apply patches or schedule an autonomous repair loop", () => {
    expect(repair).not.toMatch(/proposals\.apply\s*\(/);
    expect(repair).not.toMatch(/setInterval|setTimeout/);
    expect(repair).toContain("attemptsPerIncident");
    expect(repair).toContain('proposal.status !== "applied"');
  });
});
