import type express from "express";
import type { AuthenticatedRequest } from "./authMiddleware";
import type { AutonomousRepairEngine, BugSignalMonitor, CodeChangeProposalEngine, ControlledRepository } from "../src/lib/selfCoding";

export function registerSelfCodingRoutes(app: express.Express, deps: {
  engine: CodeChangeProposalEngine;
  repository: ControlledRepository;
  repairs?: AutonomousRepairEngine;
  monitor?: BugSignalMonitor;
  isAdmin(uid: string | undefined): boolean;
}): void {
  app.use("/api/self-coding", (req, res, next) => {
    if (!deps.isAdmin((req as AuthenticatedRequest).userId)) { res.status(403).json({ error: "Self-coding administrator access required" }); return; }
    next();
  });

  app.get("/api/self-coding/inspect/file", (req, res) => {
    const value = typeof req.query.path === "string" ? deps.repository.readSource(req.query.path) : null;
    if (!value) { res.status(404).json({ error: "allowed source file not found" }); return; }
    res.json(value);
  });
  app.get("/api/self-coding/inspect/search", (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    res.json({ hits: deps.repository.searchSymbols(query) });
  });
  app.get("/api/self-coding/inspect/dependencies", (req, res) => {
    const file = typeof req.query.path === "string" ? req.query.path : "";
    res.json({ dependencies: deps.repository.dependencies(file) });
  });
  app.get("/api/self-coding/inspect/tests", (_req, res) => res.json({ tests: deps.repository.readTests() }));
  app.get("/api/self-coding/inspect/build-output", (_req, res) => res.json({ artifact: deps.repository.readBuildOutput() }));
  app.get("/api/self-coding/inspect/error-log", (_req, res) => res.json({ artifact: deps.repository.readErrorLog() }));
  app.post("/api/self-coding/diagnose", (req, res) => {
    if (typeof req.body?.requirement !== "string") { res.status(400).json({ error: "requirement required" }); return; }
    res.json(deps.engine.diagnose(req.body.requirement.slice(0, 2_000), typeof req.body?.errorLog === "string" ? req.body.errorLog.slice(0, 20_000) : ""));
  });

  app.post("/api/self-coding/bugs/signals", async (req, res) => {
    if (!deps.monitor) { res.status(503).json({ error: "repair monitor unavailable" }); return; }
    const uid = (req as AuthenticatedRequest).userId!;
    const incident = await deps.monitor.record(uid, req.body?.source, req.body?.component, req.body?.summary, req.body?.errorCode, req.body?.evidence);
    if (!incident) { res.status(400).json({ error: "bug signal rejected" }); return; }
    res.status(201).json(incident);
  });
  app.get("/api/self-coding/bugs", async (req, res) => {
    if (!deps.repairs) { res.status(503).json({ error: "repair engine unavailable" }); return; }
    res.json({ incidents: await deps.repairs.listIncidents((req as AuthenticatedRequest).userId!) });
  });
  app.get("/api/self-coding/bugs/metrics", async (req, res) => {
    if (!deps.repairs) { res.status(503).json({ error: "repair engine unavailable" }); return; }
    res.json(await deps.repairs.metrics((req as AuthenticatedRequest).userId!));
  });
  app.get("/api/self-coding/bugs/:incidentId", async (req, res) => {
    if (!deps.repairs) { res.status(503).json({ error: "repair engine unavailable" }); return; }
    const incident = await deps.repairs.getIncident((req as AuthenticatedRequest).userId!, String(req.params.incidentId));
    if (!incident) { res.status(404).json({ error: "incident not found" }); return; }
    res.json(incident);
  });
  app.post("/api/self-coding/bugs/:incidentId/investigate", async (req, res) => {
    if (!deps.repairs) { res.status(503).json({ error: "repair engine unavailable" }); return; }
    const incident = await deps.repairs.investigate((req as AuthenticatedRequest).userId!, String(req.params.incidentId));
    res.status(incident ? 200 : 409).json(incident ?? { error: "investigation refused or needs more evidence" });
  });
  app.post("/api/self-coding/bugs/:incidentId/reproduce", async (req, res) => {
    if (!deps.repairs) { res.status(503).json({ error: "repair engine unavailable" }); return; }
    const incident = await deps.repairs.reproduce((req as AuthenticatedRequest).userId!, String(req.params.incidentId), req.body?.target);
    res.status(incident ? 200 : 409).json(incident ?? { error: "reproduction refused" });
  });
  app.post("/api/self-coding/bugs/:incidentId/candidate", async (req, res) => {
    if (!deps.repairs) { res.status(503).json({ error: "repair engine unavailable" }); return; }
    const incident = await deps.repairs.createVerifiedCandidate((req as AuthenticatedRequest).userId!, String(req.params.incidentId), {
      proposalId: typeof req.body?.proposalId === "string" ? req.body.proposalId : undefined,
      kind: "bug_fix", title: req.body?.title, reason: req.body?.reason, requirement: req.body?.requirement,
      errorLog: req.body?.errorLog, patches: Array.isArray(req.body?.patches) ? req.body.patches : [],
      tests: Array.isArray(req.body?.tests) ? req.body.tests : [], reproductionTarget: req.body?.reproductionTarget,
    });
    res.status(incident ? 200 : 409).json(incident ?? { error: "repair candidate refused or verification failed" });
  });
  app.post("/api/self-coding/bugs/:incidentId/finalize", async (req, res) => {
    if (!deps.repairs) { res.status(503).json({ error: "repair engine unavailable" }); return; }
    const memory = await deps.repairs.finalizeAppliedRepair((req as AuthenticatedRequest).userId!, String(req.params.incidentId));
    res.status(memory ? 200 : 409).json(memory ?? { error: "applied verified repair not found" });
  });
  app.get("/api/self-coding/regression-memory", async (req, res) => {
    if (!deps.repairs) { res.status(503).json({ error: "repair engine unavailable" }); return; }
    const query = typeof req.query.q === "string" ? req.query.q : "";
    res.json({ memories: await deps.repairs.retrieveRegressionMemory((req as AuthenticatedRequest).userId!, query) });
  });

  app.post("/api/self-coding/proposals", async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId!;
    const proposal = await deps.engine.create({
      uid, proposalId: typeof req.body?.proposalId === "string" ? req.body.proposalId : undefined,
      kind: req.body?.kind, title: req.body?.title, reason: req.body?.reason,
      requirement: req.body?.requirement, errorLog: req.body?.errorLog,
      diagnosis: req.body?.diagnosis, rootCauseHypothesis: req.body?.rootCauseHypothesis,
      patches: Array.isArray(req.body?.patches) ? req.body.patches : [],
      tests: Array.isArray(req.body?.tests) ? req.body.tests.filter((value: unknown): value is string => typeof value === "string") : [],
    });
    if (!proposal) { res.status(400).json({ error: "proposal rejected" }); return; }
    res.status(201).json(proposal);
  });
  app.get("/api/self-coding/proposals", async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId!;
    res.json({ proposals: await deps.engine.list(uid, typeof req.query.proposalId === "string" ? req.query.proposalId : undefined) });
  });
  app.get("/api/self-coding/proposals/:proposalId/versions/:version", async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId!; const version = parseVersion(req.params.version);
    const proposal = version ? await deps.engine.get(uid, String(req.params.proposalId), version) : null;
    if (!proposal) { res.status(404).json({ error: "proposal not found" }); return; }
    res.json(proposal);
  });
  app.get("/api/self-coding/proposals/:proposalId/audit", async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId!;
    res.json({ events: await deps.engine.audit(uid, String(req.params.proposalId)) });
  });

  app.post("/api/self-coding/proposals/:proposalId/versions/:version/verify", async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId!; const version = parseVersion(req.params.version);
    if (!version) { res.status(400).json({ error: "invalid version" }); return; }
    const proposal = await deps.engine.verify(uid, String(req.params.proposalId), version);
    res.status(proposal ? 200 : 409).json(proposal ?? { error: "verification refused" });
  });
  app.post("/api/self-coding/proposals/:proposalId/versions/:version/request-approval", async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId!; const version = parseVersion(req.params.version);
    if (!version) { res.status(400).json({ error: "invalid version" }); return; }
    const result = await deps.engine.requestApproval(uid, String(req.params.proposalId), version);
    res.status(result ? 200 : 409).json(result ?? { error: "approval request refused" });
  });
  app.post("/api/self-coding/proposals/:proposalId/versions/:version/approve", async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId!; const version = parseVersion(req.params.version);
    if (!version || req.body?.approved !== true || typeof req.body?.approvalRequestId !== "string") { res.status(400).json({ error: "explicit approval and request id required" }); return; }
    const proposal = await deps.engine.approve({ uid, proposalId: String(req.params.proposalId), version, approvalRequestId: req.body.approvalRequestId, approved: true });
    res.status(proposal ? 200 : 409).json(proposal ?? { error: "approval refused" });
  });
  app.post("/api/self-coding/proposals/:proposalId/versions/:version/reject", async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId!; const version = parseVersion(req.params.version);
    if (!version) { res.status(400).json({ error: "invalid version" }); return; }
    const rejected = await deps.engine.reject(uid, String(req.params.proposalId), version, typeof req.body?.reason === "string" ? req.body.reason : "rejected");
    res.status(rejected ? 200 : 409).json({ rejected });
  });
  app.post("/api/self-coding/proposals/:proposalId/versions/:version/apply", async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId!; const version = parseVersion(req.params.version);
    if (!version || req.body?.applyApprovedPatch !== true) { res.status(400).json({ error: "explicit apply acknowledgement required" }); return; }
    const proposal = await deps.engine.apply(uid, String(req.params.proposalId), version);
    res.status(proposal ? 200 : 409).json(proposal ?? { error: "apply refused" });
  });
}

function parseVersion(value: unknown): number | null { const version = Number(value); return Number.isInteger(version) && version >= 1 && version <= 10_000 ? version : null; }
