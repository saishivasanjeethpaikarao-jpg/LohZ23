import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 37 production wiring", () => {
  const server = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
  const ui = fs.readFileSync(path.join(process.cwd(), "src/components/HealthCenter.tsx"), "utf8");

  it("keeps health endpoints behind authenticated API middleware", () => {
    expect(server.indexOf('app.use("/api", authMiddleware')).toBeGreaterThan(-1);
    expect(server.indexOf('app.use("/api", authMiddleware')).toBeLessThan(server.indexOf('app.get("/api/health"'));
    expect(server).toContain('/api/self-model/capabilities');
  });

  it("uses Firestore when available and restart-safe local persistence otherwise", () => {
    expect(server).toContain("new LocalSelfModelStore()");
    expect(server).toContain("new FirestoreSelfModelStore(firestore)");
    expect(server).toContain("new OperationalHealthCoordinator");
  });

  it("renders measured, accessible health rather than a fixed score", () => {
    expect(ui).toContain('fetch("/api/health"');
    expect(ui).toContain('role="progressbar"');
    expect(ui).toContain("snapshot.overallScore");
    expect(ui).not.toMatch(/health\s*=\s*100/i);
  });
});

