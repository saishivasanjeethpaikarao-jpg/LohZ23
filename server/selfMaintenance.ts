import type express from "express";
import type { AuthenticatedRequest } from "./authMiddleware";
import type { HealthSnapshot as OperationalSnapshot } from "../src/lib/health/types";
import { newMaintenanceRecord, type DiagnosticEngine, type MaintenanceHistoryStore, type RepositoryInspector } from "../src/lib/selfMaintenance";

export function registerSelfMaintenanceRoutes(app: express.Express, deps: {
  inspector: RepositoryInspector;
  diagnostics: DiagnosticEngine;
  history: MaintenanceHistoryStore;
  refreshHealth: (uid: string) => Promise<OperationalSnapshot | null>;
  isAdmin(uid: string | undefined): boolean;
}): void {
  app.use("/api/self-maintenance", (req, res, next) => {
    if (!deps.isAdmin((req as AuthenticatedRequest).userId)) { res.status(403).json({ error: "Self-maintenance administrator access required" }); return; }
    next();
  });
  app.get("/api/self-maintenance/repository", (_req, res) => res.json({ files: deps.inspector.listFiles(), tests: deps.inspector.tests(), gitStatus: deps.inspector.gitStatus(), recentCommits: deps.inspector.recentCommits() }));
  app.post("/api/self-maintenance/diagnose", async (req, res) => {
    if (typeof req.body?.subsystem !== "string" || typeof req.body?.symptom !== "string") { res.status(400).json({ error: "subsystem and symptom required" }); return; }
    const diagnosis = deps.diagnostics.diagnose({ incidentId: typeof req.body.incidentId === "string" ? req.body.incidentId : undefined, subsystem: req.body.subsystem, symptom: req.body.symptom, severity: req.body.severity, evidence: Array.isArray(req.body.evidence) ? req.body.evidence : [], recentChanges: Array.isArray(req.body.recentChanges) ? req.body.recentChanges : [] });
    const record = newMaintenanceRecord((req as AuthenticatedRequest).userId!, diagnosis);
    await deps.history.append(record);
    res.status(201).json({ diagnosis, record });
  });
  app.get("/api/self-maintenance/health", async (req, res) => {
    const snapshot = await deps.refreshHealth((req as AuthenticatedRequest).userId!);
    if (!snapshot) { res.status(503).json({ error: "health unavailable" }); return; }
    res.json({ snapshotId: `operational-${snapshot.generatedAt}`, generatedAt: snapshot.generatedAt, mode: "standard", overallScore: snapshot.overallScore, status: snapshot.status.toUpperCase(), subsystems: snapshot.subsystems.map((item) => ({ subsystem: item.capabilityId, category: item.category, status: item.status.toUpperCase(), score: item.score, confidence: item.confidence, checkedAt: item.lastVerifiedAt ?? snapshot.generatedAt, checksPerformed: ["operational_health_coordinator"], failures: item.status === "critical" || item.status === "offline" ? [item.detailCode ?? "subsystem_failure"] : [], warnings: item.stale ? ["stale_observation"] : [], evidence: item.detailCode ? [item.detailCode] : [], dependencies: [] })) });
  });
  app.get("/api/self-maintenance/history", async (req, res) => res.json({ records: await deps.history.list((req as AuthenticatedRequest).userId!) }));
}
