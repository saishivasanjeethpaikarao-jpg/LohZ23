import type { CodeChangeAuditEvent, CodeChangeProposal } from "./types";
import { SELF_CODING_LIMITS } from "./types";
import type { BugIncident, RegressionMemory } from "./repairTypes";
import { REPAIR_LIMITS } from "./repairTypes";

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export interface SelfCodingStore {
  createProposal(proposal: CodeChangeProposal, audit: CodeChangeAuditEvent): Promise<boolean>;
  getProposal(uid: string, proposalId: string, version: number): Promise<CodeChangeProposal | null>;
  listProposals(uid: string, proposalId?: string): Promise<CodeChangeProposal[]>;
  compareAndSetProposal(next: CodeChangeProposal, expectedRevision: number, audit: CodeChangeAuditEvent): Promise<boolean>;
  appendAudit(event: CodeChangeAuditEvent): Promise<boolean>;
  listAudit(uid: string, proposalId: string): Promise<CodeChangeAuditEvent[]>;
  createIncident(incident: BugIncident): Promise<boolean>;
  getIncident(uid: string, incidentId: string): Promise<BugIncident | null>;
  listIncidents(uid: string): Promise<BugIncident[]>;
  compareAndSetIncident(next: BugIncident, expectedRevision: number): Promise<boolean>;
  putRegressionMemory(memory: RegressionMemory): Promise<boolean>;
  listRegressionMemories(uid: string): Promise<RegressionMemory[]>;
}

export class InMemorySelfCodingStore implements SelfCodingStore {
  private proposals = new Map<string, CodeChangeProposal>();
  private audit = new Map<string, CodeChangeAuditEvent>();
  private incidents = new Map<string, BugIncident>();
  private memories = new Map<string, RegressionMemory>();
  private key(uid: string, id: string, version: number): string { return `${uid}:${id}:v${version}`; }

  async createProposal(proposal: CodeChangeProposal, audit: CodeChangeAuditEvent): Promise<boolean> {
    const key = this.key(proposal.uid, proposal.proposalId, proposal.version);
    if (this.proposals.has(key)) return false;
    if ([...this.proposals.values()].filter((value) => value.uid === proposal.uid).length >= SELF_CODING_LIMITS.maxProposalsPerUser) return false;
    const versions = [...this.proposals.values()].filter((value) => value.uid === proposal.uid && value.proposalId === proposal.proposalId);
    const latest = versions.length ? Math.max(...versions.map((value) => value.version)) : 0;
    if (proposal.version !== latest + 1) return false;
    const auditKey = `${audit.uid}:${audit.eventId}`;
    if (audit.uid !== proposal.uid || audit.proposalId !== proposal.proposalId || this.audit.has(auditKey)) return false;
    this.proposals.set(key, clone(proposal)); this.audit.set(auditKey, clone(audit)); return true;
  }
  async getProposal(uid: string, proposalId: string, version: number): Promise<CodeChangeProposal | null> {
    const value = this.proposals.get(this.key(uid, proposalId, version)); return value?.uid === uid ? clone(value) : null;
  }
  async listProposals(uid: string, proposalId?: string): Promise<CodeChangeProposal[]> {
    return [...this.proposals.values()].filter((value) => value.uid === uid && (!proposalId || value.proposalId === proposalId))
      .sort((a, b) => a.createdAt - b.createdAt || a.version - b.version).map(clone);
  }
  async compareAndSetProposal(next: CodeChangeProposal, expectedRevision: number, audit: CodeChangeAuditEvent): Promise<boolean> {
    const key = this.key(next.uid, next.proposalId, next.version); const current = this.proposals.get(key);
    const auditKey = `${audit.uid}:${audit.eventId}`;
    if (!current || current.revision !== expectedRevision || next.revision !== expectedRevision + 1 || audit.uid !== next.uid || audit.proposalId !== next.proposalId || this.audit.has(auditKey)) return false;
    this.proposals.set(key, clone(next)); this.audit.set(auditKey, clone(audit)); return true;
  }
  async appendAudit(event: CodeChangeAuditEvent): Promise<boolean> {
    const key = `${event.uid}:${event.eventId}`; if (this.audit.has(key)) return false;
    this.audit.set(key, clone(event)); return true;
  }
  async listAudit(uid: string, proposalId: string): Promise<CodeChangeAuditEvent[]> {
    return [...this.audit.values()].filter((value) => value.uid === uid && value.proposalId === proposalId)
      .sort((a, b) => a.timestamp - b.timestamp).map(clone);
  }
  async createIncident(incident: BugIncident): Promise<boolean> {
    const key = `${incident.uid}:${incident.incidentId}`;
    if (this.incidents.has(key) || [...this.incidents.values()].filter((value) => value.uid === incident.uid).length >= REPAIR_LIMITS.incidentsPerUser) return false;
    this.incidents.set(key, clone(incident)); return true;
  }
  async getIncident(uid: string, incidentId: string): Promise<BugIncident | null> {
    const value = this.incidents.get(`${uid}:${incidentId}`); return value?.uid === uid ? clone(value) : null;
  }
  async listIncidents(uid: string): Promise<BugIncident[]> {
    return [...this.incidents.values()].filter((value) => value.uid === uid).sort((a, b) => a.createdAt - b.createdAt).map(clone);
  }
  async compareAndSetIncident(next: BugIncident, expectedRevision: number): Promise<boolean> {
    const key = `${next.uid}:${next.incidentId}`; const current = this.incidents.get(key);
    if (!current || current.revision !== expectedRevision || next.revision !== expectedRevision + 1) return false;
    this.incidents.set(key, clone(next)); return true;
  }
  async putRegressionMemory(memory: RegressionMemory): Promise<boolean> {
    const key = `${memory.uid}:${memory.memoryId}`;
    if (this.memories.has(key) || [...this.memories.values()].filter((value) => value.uid === memory.uid).length >= REPAIR_LIMITS.memoriesPerUser) return false;
    this.memories.set(key, clone(memory)); return true;
  }
  async listRegressionMemories(uid: string): Promise<RegressionMemory[]> {
    return [...this.memories.values()].filter((value) => value.uid === uid).sort((a, b) => b.verifiedAt - a.verifiedAt).map(clone);
  }
}
