import fs from "node:fs";
import path from "node:path";
import type { SelfModelDocument } from "./types";
import { runtimeDataRoot } from "../runtimePaths";

export interface SelfModelTransaction<T> { document: SelfModelDocument; result: T; }

export interface SelfModelStore {
  load(uid: string): Promise<SelfModelDocument | null>;
  transact<T>(uid: string, mutation: (current: SelfModelDocument) => SelfModelTransaction<T> | null): Promise<T | null>;
  backendName(): string;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const validUid = (uid: string): boolean => Boolean(uid) && uid.length <= 128 && !uid.includes("/") && !uid.includes("\0");
const empty = (uid: string): SelfModelDocument => ({ uid, schemaVersion: 1, capabilities: [], updatedAt: 0 });
const valid = (uid: string, document: SelfModelDocument): boolean => document?.uid === uid
  && document.schemaVersion === 1 && Array.isArray(document.capabilities)
  && document.capabilities.every((item) => item?.uid === uid);

export class InMemorySelfModelStore implements SelfModelStore {
  private data = new Map<string, SelfModelDocument>();
  private queues = new Map<string, Promise<void>>();

  async load(uid: string): Promise<SelfModelDocument | null> {
    if (!validUid(uid)) return null;
    return clone(this.data.get(uid) ?? empty(uid));
  }

  async transact<T>(uid: string, mutation: (current: SelfModelDocument) => SelfModelTransaction<T> | null): Promise<T | null> {
    if (!validUid(uid)) return null;
    const previous = this.queues.get(uid) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => pending);
    this.queues.set(uid, tail);
    await previous.catch(() => undefined);
    try {
      const changed = mutation(clone(this.data.get(uid) ?? empty(uid)));
      if (!changed || !valid(uid, changed.document)) return null;
      this.data.set(uid, clone(changed.document));
      return clone(changed.result);
    } finally {
      release();
      if (this.queues.get(uid) === tail) this.queues.delete(uid);
    }
  }

  backendName(): string { return "memory-self-model"; }
}

export class LocalSelfModelStore implements SelfModelStore {
  private root: string;
  private queues = new Map<string, Promise<void>>();

  constructor(root = runtimeDataRoot("self-model")) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private file(uid: string): string {
    if (!validUid(uid)) throw new Error("LocalSelfModelStore: invalid uid");
    return path.join(this.root, `${Buffer.from(uid).toString("base64url")}.json`);
  }

  private read(uid: string): SelfModelDocument | null {
    const file = this.file(uid);
    if (!fs.existsSync(file)) return empty(uid);
    try {
      const document = JSON.parse(fs.readFileSync(file, "utf8")) as SelfModelDocument;
      return valid(uid, document) ? document : null;
    } catch { return null; }
  }

  async load(uid: string): Promise<SelfModelDocument | null> {
    try { const document = this.read(uid); return document ? clone(document) : null; } catch { return null; }
  }

  async transact<T>(uid: string, mutation: (current: SelfModelDocument) => SelfModelTransaction<T> | null): Promise<T | null> {
    if (!validUid(uid)) return null;
    const previous = this.queues.get(uid) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => pending);
    this.queues.set(uid, tail);
    await previous.catch(() => undefined);
    try {
      const current = this.read(uid);
      if (!current) return null;
      const changed = mutation(clone(current));
      if (!changed || !valid(uid, changed.document)) return null;
      const file = this.file(uid); const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify(changed.document), { encoding: "utf8", flag: "wx" });
        fs.renameSync(temp, file);
      } catch {
        try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
        return null;
      }
      return clone(changed.result);
    } finally {
      release();
      if (this.queues.get(uid) === tail) this.queues.delete(uid);
    }
  }

  backendName(): string { return "local-self-model"; }
}

