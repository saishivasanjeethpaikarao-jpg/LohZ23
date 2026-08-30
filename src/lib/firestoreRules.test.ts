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
});
