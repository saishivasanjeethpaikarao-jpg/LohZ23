import type { FirestoreLike } from "../persistence/firestoreUserStore";
import type { SelfCodingStore } from "./store";
import type { CodeChangeAuditEvent, CodeChangeProposal } from "./types";
import type { BugIncident, RegressionMemory } from "./repairTypes";

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function safeUid(uid: string): string { if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("FirestoreSelfCodingStore: invalid uid"); return uid; }
function safeId(value: string): string { if (!value || value.length > 512) throw new Error("FirestoreSelfCodingStore: invalid id"); return Buffer.from(value, "utf8").toString("base64url"); }

export class FirestoreSelfCodingStore implements SelfCodingStore {
  constructor(private readonly db: FirestoreLike, private readonly log: (message: string, error?: unknown) => void = (message, error) => console.warn(`[firestore-self-coding] ${message}`, error ?? "")) {}
  private path(uid: string, collection: string, id: string): string { return `users/${safeUid(uid)}/${collection}/${safeId(id)}`; }
  private proposalPath(uid: string, id: string, version: number): string { return this.path(uid, "codeChangeProposals", `${id}:v${version}`); }

  async createProposal(proposal: CodeChangeProposal, event: CodeChangeAuditEvent): Promise<boolean> {
    try {
      const proposalPath = this.proposalPath(proposal.uid, proposal.proposalId, proposal.version);
      const headPath = this.path(proposal.uid, "codeChangeHeads", proposal.proposalId);
      const auditPath = this.path(proposal.uid, "codeChangeAudit", event.eventId);
      return await this.db.runTransaction(async (tx) => {
        const [proposalSnap, headSnap, auditSnap] = await Promise.all([tx.get({ path: proposalPath }), tx.get({ path: headPath }), tx.get({ path: auditPath })]);
        const latest = headSnap.exists ? Number((headSnap.data() as { latestVersion?: unknown }).latestVersion) : 0;
        if (proposalSnap.exists || auditSnap.exists || proposal.version !== latest + 1 || event.uid !== proposal.uid || event.proposalId !== proposal.proposalId) return false;
        tx.set({ path: proposalPath }, clone(proposal)); tx.set({ path: auditPath }, clone(event));
        tx.set({ path: headPath }, { uid: proposal.uid, proposalId: proposal.proposalId, latestVersion: proposal.version, updatedAt: proposal.updatedAt }); return true;
      });
    } catch (error) { this.log("create failed", error); return false; }
  }
  async getProposal(uid: string, proposalId: string, version: number): Promise<CodeChangeProposal | null> {
    try { const snap = await this.db.doc(this.proposalPath(uid, proposalId, version)).get(); const value = snap.exists ? snap.data() as CodeChangeProposal : null; return value?.uid === uid && value.proposalId === proposalId && value.version === version ? clone(value) : null; }
    catch (error) { this.log("get failed", error); return null; }
  }
  async listProposals(uid: string, proposalId?: string): Promise<CodeChangeProposal[]> {
    try {
      const output: CodeChangeProposal[] = [];
      for (const id of await this.db.collection(`users/${safeUid(uid)}/codeChangeProposals`).listIds()) {
        const snap = await this.db.doc(`users/${safeUid(uid)}/codeChangeProposals/${id}`).get();
        if (snap.exists) { const value = snap.data() as CodeChangeProposal; if (value?.uid === uid && (!proposalId || value.proposalId === proposalId)) output.push(clone(value)); }
      }
      return output.sort((a, b) => a.createdAt - b.createdAt || a.version - b.version);
    } catch (error) { this.log("list failed", error); return []; }
  }
  async compareAndSetProposal(next: CodeChangeProposal, expectedRevision: number, event: CodeChangeAuditEvent): Promise<boolean> {
    try {
      const proposalPath = this.proposalPath(next.uid, next.proposalId, next.version); const auditPath = this.path(next.uid, "codeChangeAudit", event.eventId);
      return await this.db.runTransaction(async (tx) => {
        const [proposalSnap, auditSnap] = await Promise.all([tx.get({ path: proposalPath }), tx.get({ path: auditPath })]);
        if (!proposalSnap.exists || auditSnap.exists) return false;
        const current = proposalSnap.data() as CodeChangeProposal;
        if (current.uid !== next.uid || current.revision !== expectedRevision || next.revision !== expectedRevision + 1 || event.uid !== next.uid || event.proposalId !== next.proposalId) return false;
        tx.set({ path: proposalPath }, clone(next)); tx.set({ path: auditPath }, clone(event)); return true;
      });
    } catch (error) { this.log("transition failed", error); return false; }
  }
  async appendAudit(event: CodeChangeAuditEvent): Promise<boolean> {
    try { const path = this.path(event.uid, "codeChangeAudit", event.eventId); return await this.db.runTransaction(async (tx) => { if ((await tx.get({ path })).exists) return false; tx.set({ path }, clone(event)); return true; }); }
    catch { return false; }
  }
  async listAudit(uid: string, proposalId: string): Promise<CodeChangeAuditEvent[]> {
    try {
      const output: CodeChangeAuditEvent[] = [];
      for (const id of await this.db.collection(`users/${safeUid(uid)}/codeChangeAudit`).listIds()) {
        const snap = await this.db.doc(`users/${safeUid(uid)}/codeChangeAudit/${id}`).get();
        if (snap.exists) { const value = snap.data() as CodeChangeAuditEvent; if (value?.uid === uid && value.proposalId === proposalId) output.push(clone(value)); }
      }
      return output.sort((a, b) => a.timestamp - b.timestamp);
    } catch { return []; }
  }
  async createIncident(incident: BugIncident): Promise<boolean> {
    try {
      const path = this.path(incident.uid, "bugIncidents", incident.incidentId);
      return await this.db.runTransaction(async (tx) => {
        if ((await tx.get({ path })).exists) return false;
        tx.set({ path }, clone(incident)); return true;
      });
    } catch (error) { this.log("incident create failed", error); return false; }
  }
  async getIncident(uid: string, incidentId: string): Promise<BugIncident | null> {
    try {
      const snap = await this.db.doc(this.path(uid, "bugIncidents", incidentId)).get();
      const value = snap.exists ? snap.data() as BugIncident : null;
      return value?.uid === uid && value.incidentId === incidentId ? clone(value) : null;
    } catch { return null; }
  }
  async listIncidents(uid: string): Promise<BugIncident[]> {
    try {
      const output: BugIncident[] = [];
      for (const id of await this.db.collection(`users/${safeUid(uid)}/bugIncidents`).listIds()) {
        const snap = await this.db.doc(`users/${safeUid(uid)}/bugIncidents/${id}`).get();
        if (snap.exists) { const value = snap.data() as BugIncident; if (value?.uid === uid) output.push(clone(value)); }
      }
      return output.sort((a, b) => a.createdAt - b.createdAt);
    } catch { return []; }
  }
  async compareAndSetIncident(next: BugIncident, expectedRevision: number): Promise<boolean> {
    try {
      const path = this.path(next.uid, "bugIncidents", next.incidentId);
      return await this.db.runTransaction(async (tx) => {
        const snap = await tx.get({ path }); if (!snap.exists) return false;
        const current = snap.data() as BugIncident;
        if (current.uid !== next.uid || current.revision !== expectedRevision || next.revision !== expectedRevision + 1) return false;
        tx.set({ path }, clone(next)); return true;
      });
    } catch { return false; }
  }
  async putRegressionMemory(memory: RegressionMemory): Promise<boolean> {
    try {
      const path = this.path(memory.uid, "regressionMemories", memory.memoryId);
      return await this.db.runTransaction(async (tx) => {
        if ((await tx.get({ path })).exists) return false;
        tx.set({ path }, clone(memory)); return true;
      });
    } catch { return false; }
  }
  async listRegressionMemories(uid: string): Promise<RegressionMemory[]> {
    try {
      const output: RegressionMemory[] = [];
      for (const id of await this.db.collection(`users/${safeUid(uid)}/regressionMemories`).listIds()) {
        const snap = await this.db.doc(`users/${safeUid(uid)}/regressionMemories/${id}`).get();
        if (snap.exists) { const value = snap.data() as RegressionMemory; if (value?.uid === uid) output.push(clone(value)); }
      }
      return output.sort((a, b) => b.verifiedAt - a.verifiedAt);
    } catch { return []; }
  }
}
