import type { HealthSnapshot } from "../health/types";
import type { AutonomousRepairEngine } from "./repairEngine";
import type { BugIncident, BugSignalSource } from "./repairTypes";

/** Bounded event adapter; it never schedules repair attempts or loops. */
export class BugSignalMonitor {
  constructor(private readonly repairs: AutonomousRepairEngine) {}

  async record(uid: string, source: BugSignalSource, component: string, summary: string, errorCode?: string | null, evidence = ""): Promise<BugIncident | null> {
    try { return await this.repairs.detect({ uid, source, component, summary, errorCode, evidence, authoritative: source !== "provider_failure" }); }
    catch { return null; } // monitoring must never change the observed operation's truth
  }

  async observeHealth(snapshot: HealthSnapshot): Promise<BugIncident[]> {
    const output: BugIncident[] = [];
    for (const subsystem of snapshot.subsystems) {
      if (!["degraded", "critical", "offline"].includes(subsystem.status)) continue;
      const incident = await this.record(snapshot.uid, "health_degradation", subsystem.capabilityId, `${subsystem.label} health is ${subsystem.status}`, subsystem.detailCode);
      if (incident) output.push(incident);
    }
    return output;
  }

  provider(uid: string, provider: string, success: boolean, detail = "request_failed"): Promise<BugIncident | null> {
    return success ? Promise.resolve(null) : this.record(uid, "provider_failure", `provider:${provider}`, `${provider} provider request failed`, detail);
  }

  execution(uid: string, component: string, success: boolean, detail = "execution_failed"): Promise<BugIncident | null> {
    return success ? Promise.resolve(null) : this.record(uid, "execution_failure", component, `${component} execution failed`, detail);
  }
}
