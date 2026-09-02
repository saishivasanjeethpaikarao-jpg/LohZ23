import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SelfCodingStore } from "./store";
import type { CodeChangeAuditEvent, CodeChangeProposal } from "./types";
import { SELF_CODING_LIMITS } from "./types";
import type { BugIncident, RegressionMemory } from "./repairTypes";
import { REPAIR_LIMITS } from "./repairTypes";
import { runtimeDataRoot } from "../runtimePaths";

interface Data {
  uid: string;
  schemaVersion: 1;
  proposals: Record<string, CodeChangeProposal>;
  audit: Record<string, CodeChangeAuditEvent>;
  incidents?: Record<string, BugIncident>;
  regressionMemories?: Record<string, RegressionMemory>;
  updatedAt: number;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function safeUid(uid: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("LocalSelfCodingStore: invalid uid");
  return Buffer.from(uid, "utf8").toString("base64url");
}
function key(id: string, version: number): string { return `${id}:v${version}`; }

export class LocalSelfCodingStore implements SelfCodingStore {
  private readonly root: string;
  private readonly queues = new Map<string, Promise<void>>();
  constructor(root = runtimeDataRoot("phase43-self-coding")) { this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true }); }
  private file(uid: string): string { return path.join(this.root, `${safeUid(uid)}.json`); }
  private load(uid: string): Data {
    const file = this.file(uid); if (!fs.existsSync(file)) return { uid, schemaVersion: 1, proposals: {}, audit: {}, incidents: {}, regressionMemories: {}, updatedAt: Date.now() };
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Data;
    if (value.uid !== uid || value.schemaVersion !== 1) throw new Error("LocalSelfCodingStore: owner/schema mismatch");
    value.incidents ??= {}; value.regressionMemories ??= {};
    return value;
  }
  private save(uid: string, data: Data): boolean {
    const file = this.file(uid); const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try { data.updatedAt = Date.now(); fs.writeFileSync(temp, JSON.stringify(data), { encoding: "utf8", flag: "wx" }); fs.renameSync(temp, file); return true; }
    catch { try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ } return false; }
  }
  private async locked<T>(uid: string, work: (data: Data) => T): Promise<T> {
    const prior = this.queues.get(uid) ?? Promise.resolve(); let result!: T;
    const current = prior.catch(() => undefined).then(() => { result = work(this.load(uid)); });
    const marker = current.then(() => undefined, () => undefined); this.queues.set(uid, marker); await current;
    if (this.queues.get(uid) === marker) this.queues.delete(uid); return result;
  }
  private async settled(uid: string): Promise<void> { await (this.queues.get(uid) ?? Promise.resolve()); }

  async createProposal(proposal: CodeChangeProposal, event: CodeChangeAuditEvent): Promise<boolean> {
    return this.locked(proposal.uid, (data) => {
      const k = key(proposal.proposalId, proposal.version);
      if (data.proposals[k] || data.audit[event.eventId] || event.uid !== proposal.uid || event.proposalId !== proposal.proposalId) return false;
      const versions = Object.values(data.proposals).filter((value) => value.proposalId === proposal.proposalId);
      const latest = versions.length ? Math.max(...versions.map((value) => value.version)) : 0;
      if (proposal.version !== latest + 1 || Object.keys(data.proposals).length >= SELF_CODING_LIMITS.maxProposalsPerUser) return false;
      data.proposals[k] = clone(proposal); data.audit[event.eventId] = clone(event); return this.save(proposal.uid, data);
    });
  }
  async getProposal(uid: string, proposalId: string, version: number): Promise<CodeChangeProposal | null> {
    await this.settled(uid); const value = this.load(uid).proposals[key(proposalId, version)]; return value?.uid === uid ? clone(value) : null;
  }
  async listProposals(uid: string, proposalId?: string): Promise<CodeChangeProposal[]> {
    await this.settled(uid); return Object.values(this.load(uid).proposals).filter((value) => !proposalId || value.proposalId === proposalId)
      .sort((a, b) => a.createdAt - b.createdAt || a.version - b.version).map(clone);
  }
  async compareAndSetProposal(next: CodeChangeProposal, expectedRevision: number, event: CodeChangeAuditEvent): Promise<boolean> {
    return this.locked(next.uid, (data) => {
      const k = key(next.proposalId, next.version); const current = data.proposals[k];
      if (!current || current.revision !== expectedRevision || next.revision !== expectedRevision + 1 || data.audit[event.eventId] || event.uid !== next.uid || event.proposalId !== next.proposalId) return false;
      data.proposals[k] = clone(next); data.audit[event.eventId] = clone(event); return this.save(next.uid, data);
    });
  }
  async appendAudit(event: CodeChangeAuditEvent): Promise<boolean> {
    return this.locked(event.uid, (data) => { if (data.audit[event.eventId]) return false; data.audit[event.eventId] = clone(event); return this.save(event.uid, data); });
  }
  async listAudit(uid: string, proposalId: string): Promise<CodeChangeAuditEvent[]> {
    await this.settled(uid); return Object.values(this.load(uid).audit).filter((value) => value.proposalId === proposalId)
      .sort((a, b) => a.timestamp - b.timestamp).map(clone);
  }
  async createIncident(incident: BugIncident): Promise<boolean> {
    return this.locked(incident.uid, (data) => {
      const incidents = data.incidents!;
      if (incidents[incident.incidentId] || Object.keys(incidents).length >= REPAIR_LIMITS.incidentsPerUser) return false;
      incidents[incident.incidentId] = clone(incident); return this.save(incident.uid, data);
    });
  }
  async getIncident(uid: string, incidentId: string): Promise<BugIncident | null> {
    await this.settled(uid); const value = this.load(uid).incidents![incidentId]; return value?.uid === uid ? clone(value) : null;
  }
  async listIncidents(uid: string): Promise<BugIncident[]> {
    await this.settled(uid); return Object.values(this.load(uid).incidents!).sort((a, b) => a.createdAt - b.createdAt).map(clone);
  }
  async compareAndSetIncident(next: BugIncident, expectedRevision: number): Promise<boolean> {
    return this.locked(next.uid, (data) => {
      const current = data.incidents![next.incidentId];
      if (!current || current.revision !== expectedRevision || next.revision !== expectedRevision + 1) return false;
      data.incidents![next.incidentId] = clone(next); return this.save(next.uid, data);
    });
  }
  async putRegressionMemory(memory: RegressionMemory): Promise<boolean> {
    return this.locked(memory.uid, (data) => {
      const values = data.regressionMemories!;
      if (values[memory.memoryId] || Object.keys(values).length >= REPAIR_LIMITS.memoriesPerUser) return false;
      values[memory.memoryId] = clone(memory); return this.save(memory.uid, data);
    });
  }
  async listRegressionMemories(uid: string): Promise<RegressionMemory[]> {
    await this.settled(uid); return Object.values(this.load(uid).regressionMemories!).sort((a, b) => b.verifiedAt - a.verifiedAt).map(clone);
  }
}
