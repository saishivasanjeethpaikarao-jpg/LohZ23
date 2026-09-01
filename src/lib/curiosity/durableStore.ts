/**
 * Phase 42 — restart-safe local persistence for curiosity state.
 * Same pattern as LocalLearningStore: per-user atomic JSON replace,
 * serialized mutations, corrupt-file fail-closed.
 */
import fs from "node:fs";
import path from "node:path";
import type { CuriosityStore } from "./store";
import { CURIOSITY_LIMITS, type CuriosityInteraction, type KnowledgeGap } from "./types";

interface CuriosityData {
  uid: string;
  schemaVersion: 1;
  gaps: Record<string, KnowledgeGap>;
  interactions: CuriosityInteraction[];
  updatedAt: number;
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
function safeUid(uid: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("LocalCuriosityStore: invalid uid");
  return Buffer.from(uid, "utf8").toString("base64url");
}

export class LocalCuriosityStore implements CuriosityStore {
  private root: string;
  private queues = new Map<string, Promise<void>>();
  constructor(root = path.join(process.cwd(), "data", "phase42-curiosity")) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private file(uid: string): string { return path.join(this.root, `${safeUid(uid)}.json`); }

  private load(uid: string): CuriosityData {
    const file = this.file(uid);
    if (!fs.existsSync(file)) return { uid, schemaVersion: 1, gaps: {}, interactions: [], updatedAt: Date.now() };
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as CuriosityData;
    if (data.uid !== uid || data.schemaVersion !== 1) throw new Error("LocalCuriosityStore: owner/schema mismatch");
    return data;
  }

  private save(uid: string, data: CuriosityData): boolean {
    if (data.uid !== uid) return false;
    const file = this.file(uid);
    const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      data.updatedAt = Date.now();
      fs.writeFileSync(temp, JSON.stringify(data), { encoding: "utf8", flag: "wx" });
      fs.renameSync(temp, file);
      return true;
    } catch {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
      return false;
    }
  }

  private async locked<T>(uid: string, fn: (data: CuriosityData) => T): Promise<T> {
    const previous = this.queues.get(uid) ?? Promise.resolve();
    let result!: T;
    const work = previous.catch(() => undefined).then(() => { result = fn(this.load(uid)); });
    const marker = work.then(() => undefined, () => undefined);
    this.queues.set(uid, marker);
    await work;
    if (this.queues.get(uid) === marker) this.queues.delete(uid);
    return result;
  }

  private async settled(uid: string): Promise<void> { await (this.queues.get(uid) ?? Promise.resolve()); }

  async upsertGap(gap: KnowledgeGap): Promise<boolean> {
    return this.locked(gap.uid, (data) => {
      data.gaps[gap.gapId] = clone(gap);
      return this.save(gap.uid, data);
    });
  }
  async getGap(uid: string, gapId: string): Promise<KnowledgeGap | null> {
    await this.settled(uid);
    const g = this.load(uid).gaps[gapId];
    return g && g.uid === uid ? clone(g) : null;
  }
  async listGaps(uid: string): Promise<KnowledgeGap[]> {
    await this.settled(uid);
    return Object.values(this.load(uid).gaps).filter((g) => g.uid === uid).map(clone);
  }
  async deleteGap(uid: string, gapId: string): Promise<boolean> {
    return this.locked(uid, (data) => {
      if (!data.gaps[gapId]) return false;
      delete data.gaps[gapId];
      return this.save(uid, data);
    });
  }
  async appendInteraction(entry: CuriosityInteraction): Promise<boolean> {
    return this.locked(entry.uid, (data) => {
      data.interactions.push(clone(entry));
      while (data.interactions.length > CURIOSITY_LIMITS.maxInteractionsLogged) data.interactions.shift();
      return this.save(entry.uid, data);
    });
  }
  async recentInteractions(uid: string, sinceMs: number): Promise<CuriosityInteraction[]> {
    await this.settled(uid);
    return this.load(uid).interactions.filter((e) => e.at >= sinceMs && e.uid === uid).map(clone);
  }
}
