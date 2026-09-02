import { randomUUID } from "node:crypto";
import type { HealthCheckMode, HealthCheckResult, HealthSnapshot, HealthSubsystemResult, MaintenanceHealthStatus } from "./types";

export interface HealthCheckDefinition {
  id: string;
  subsystem: string;
  category: string;
  weight?: number;
  modes?: HealthCheckMode[];
  run: (mode: HealthCheckMode) => Promise<HealthCheckResult>;
}

export interface HealthHistoryStore { append(snapshot: HealthSnapshot): Promise<void>; list(limit?: number): Promise<HealthSnapshot[]>; }

export class InMemoryHealthHistoryStore implements HealthHistoryStore {
  private values: HealthSnapshot[] = [];
  async append(snapshot: HealthSnapshot): Promise<void> { this.values = [...this.values, snapshot].slice(-100); }
  async list(limit = 20): Promise<HealthSnapshot[]> { return this.values.slice(-Math.max(1, Math.min(100, limit))).map((item) => structuredClone(item)); }
}

export class HealthMonitor {
  constructor(private readonly checks: HealthCheckDefinition[], private readonly history: HealthHistoryStore = new InMemoryHealthHistoryStore(), private readonly now: () => number = Date.now) {}

  async run(mode: HealthCheckMode = "standard"): Promise<HealthSnapshot> {
    const selected = this.checks.filter((check) => !check.modes || check.modes.includes(mode));
    const results: HealthSubsystemResult[] = await Promise.all(selected.map(async (check) => {
      const started = this.now();
      try {
        const result = await check.run(mode);
        return { ...result, subsystem: check.subsystem, category: check.category, weight: check.weight ?? 1, durationMs: result.durationMs ?? Math.max(0, this.now() - started) };
      } catch (error) {
        return { subsystem: check.subsystem, category: check.category, weight: check.weight ?? 1, status: "UNKNOWN", score: null, confidence: 0, checkedAt: this.now(), checksPerformed: [check.id], failures: [], warnings: ["health_check_exception"], evidence: [String(error instanceof Error ? error.message : error).slice(0, 500)], dependencies: [], degradationReason: "check_failed_without_authoritative_result", durationMs: Math.max(0, this.now() - started) };
      }
    }));
    const scored = results.filter((item) => typeof item.score === "number" && Number.isFinite(item.score));
    const totalWeight = scored.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
    const overallScore = totalWeight > 0 ? Math.min(100, Math.max(0, Math.round(scored.reduce((sum, item) => sum + (item.score! * item.weight), 0) / totalWeight))) : null;
    const status = aggregateStatus(results, overallScore);
    const snapshot: HealthSnapshot = { snapshotId: randomUUID(), generatedAt: this.now(), mode, overallScore, status, subsystems: results };
    await this.history.append(snapshot);
    return snapshot;
  }

  historyList(limit = 20): Promise<HealthSnapshot[]> { return this.history.list(limit); }
}

function aggregateStatus(results: HealthSubsystemResult[], score: number | null): MaintenanceHealthStatus {
  if (!results.length || results.some((item) => item.status === "UNKNOWN" || item.status === "UNAVAILABLE")) return "UNKNOWN";
  if (results.some((item) => item.status === "FAILING")) return "FAILING";
  if (score === null) return "UNKNOWN";
  if (score >= 90 && results.every((item) => item.status === "HEALTHY")) return "HEALTHY";
  if (score >= 70) return "DEGRADED";
  return "WARNING";
}
