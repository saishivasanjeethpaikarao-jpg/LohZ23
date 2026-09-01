import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 33 Firestore rule path audit", () => {
  const rules = fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8");
  it("matches the actual _root document layout", () => {
    for (const resource of ["preferences", "cognitiveState", "userModel", "temporal"]) {
      expect(rules).toContain(`match /${resource}/_root`);
    }
  });
  it("declares owned durable execution resources", () => {
    expect(rules).toContain("request.auth.uid == uid");
    for (const resource of ["plans", "executions", "observations", "idempotency"]) {
      expect(rules).toContain(`match /${resource}/`);
    }
  });
  it("keeps Phase 36 learning writes server-mediated and owner-readable", () => {
    for (const resource of ["learningExperiences", "experienceReflections", "lessons", "decisionObservations", "adaptations", "adaptationHeads", "skills", "skillHeads", "skillReliability", "toolReliability"]) {
      expect(rules).toContain(`match /${resource}/`);
    }
    expect(rules).toContain("clients cannot forge");
  });
  it("keeps the Phase 37 self-model owner-readable and server-derived", () => {
    expect(rules).toContain("match /selfModel/_root");
    expect(rules).toContain("Clients cannot forge availability");
  });
  it("keeps Phase 41 checkpoints and distributed leases server-mediated", () => {
    expect(rules).toContain("match /executionSessions/{sessionId}");
    expect(rules).toContain("match /executionSessionLeases/{sessionId}");
    expect(rules).toContain("cannot forge completion");
  });
  it("keeps Phase 43 proposals, heads, and approval audit server-mediated", () => {
    for (const resource of ["codeChangeProposals", "codeChangeHeads", "codeChangeAudit"]) {
      expect(rules).toContain(`match /${resource}/`);
    }
    expect(rules).toContain("cannot forge verification or approval");
  });
  it("keeps Phase 44 incidents and regression memory server-derived", () => {
    for (const resource of ["bugIncidents", "regressionMemories"]) expect(rules).toContain(`match /${resource}/`);
    expect(rules).toContain("verified applied proposals");
  });
});
