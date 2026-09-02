import { randomUUID } from "node:crypto";
import type { DiagnosticConfidence, DiagnosticInput, DiagnosticResult, DiagnosticSeverity } from "./types";

const clean = (value: unknown, max: number): string => String(value ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max);

export class DiagnosticEngine {
  constructor(private readonly now: () => number = Date.now) {}

  diagnose(input: DiagnosticInput): DiagnosticResult {
    const subsystem = clean(input.subsystem, 120) || "unknown";
    const symptom = clean(input.symptom, 2_000) || "unspecified symptom";
    const evidence = (input.evidence ?? []).slice(0, 20).map((item) => ({ source: clean(item.source, 120), detail: clean(item.detail, 1_000), authoritative: item.authoritative === true })).filter((item) => item.source && item.detail);
    const authoritative = evidence.filter((item) => item.authoritative).length;
    const causes = causesFor(subsystem, symptom, evidence, authoritative);
    const allowed = new Set<DiagnosticSeverity>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
    return { incidentId: clean(input.incidentId, 160) || randomUUID(), subsystem, symptom, severity: allowed.has(input.severity as DiagnosticSeverity) ? input.severity as DiagnosticSeverity : inferSeverity(subsystem, symptom), evidence, probableCauses: causes, affectedCapabilities: affectedFor(subsystem), recommendedInvestigation: investigationFor(subsystem), recommendedRemediation: remediationFor(subsystem), generatedAt: this.now() };
  }
}

function causesFor(subsystem: string, symptom: string, evidence: Array<{ source: string; detail: string; authoritative: boolean }>, authoritative: number): DiagnosticResult["probableCauses"] {
  const text = `${subsystem} ${symptom} ${evidence.map((item) => item.detail).join(" ")}`.toLowerCase();
  const candidates: Array<[string, string]> = subsystem.toLowerCase().includes("agent")
    ? [["agent process is not running", "agent status/process evidence"], ["loopback port is unavailable", "transport symptom"], ["token or configuration mismatch", "authentication/connection evidence"], ["WebSocket connection failure", "transport symptom"]]
    : subsystem.toLowerCase().includes("persist") || subsystem.toLowerCase().includes("firestore")
      ? [["storage backend is unavailable", "persistence evidence"], ["configuration or credentials are missing", "configuration evidence"], ["state is stale or corrupt", "state evidence"]]
      : [["the subsystem returned an operational failure", "direct symptom evidence"], ["a dependency is degraded", "dependency relationship requires verification"], ["recent changes may have introduced a regression", "recent-change correlation"]];
  const basis = text.includes("auth") || text.includes("token") ? "authentication evidence" : candidates[0][1];
  const confidence: DiagnosticConfidence = authoritative >= 2 ? "HIGH" : authoritative === 1 ? "MEDIUM" : "LOW";
  return candidates.map(([cause, causeBasis], index) => ({ cause, confidence: index === 0 ? confidence : confidence === "HIGH" ? "MEDIUM" : "LOW", basis: index === 0 ? basis : causeBasis }));
}
function inferSeverity(subsystem: string, symptom: string): DiagnosticSeverity { return /auth|credential|safety|security/i.test(`${subsystem} ${symptom}`) ? "CRITICAL" : /failed|offline|unavailable|corrupt/i.test(symptom) ? "HIGH" : "MEDIUM"; }
function affectedFor(subsystem: string): string[] { return [subsystem, ...(subsystem.toLowerCase().includes("agent") ? ["execution", "observation"] : subsystem.toLowerCase().includes("persist") ? ["memory", "world_model"] : ["cognitive_core"])].slice(0, 5); }
function investigationFor(subsystem: string): string[] { return subsystem.toLowerCase().includes("agent") ? ["check agent process and loopback port", "verify token source and WebSocket status", "run a safe tool contract probe"] : ["inspect authoritative health evidence", "check dependent subsystems", "compare recent changes and regression history"]; }
function remediationFor(subsystem: string): string[] { return subsystem.toLowerCase().includes("agent") ? ["restart only through the managed Agent lifecycle", "repair connection/configuration only in an isolated candidate"] : ["prepare a bounded patch proposal", "validate in the fixed sandbox before approval"]; }
