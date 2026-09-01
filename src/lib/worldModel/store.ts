import fs from "node:fs";
import path from "node:path";
import type { WorldAssertion, WorldStateDocument } from "./types";

export interface WorldTransaction<T> {
  assertions: WorldAssertion[];
  result: T;
}

export interface WorldStateStore {
  load(uid: string): Promise<WorldAssertion[] | null>;
  transact<T>(uid: string, mutation: (current: WorldAssertion[]) => WorldTransaction<T> | null): Promise<T | null>;
  backendName(): string;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function validUid(uid: string): boolean {
  return typeof uid === "string" && uid.length > 0 && uid.length <= 128 && !uid.includes("/") && !uid.includes("\0");
}

function owned(uid: string, assertions: WorldAssertion[]): boolean {
  return assertions.every((item) => item?.uid === uid);
}

export class InMemoryWorldStateStore implements WorldStateStore {
  private readonly data = new Map<string, WorldAssertion[]>();
  private readonly queues = new Map<string, Promise<void>>();

  async load(uid: string): Promise<WorldAssertion[] | null> {
    if (!validUid(uid)) return null;
    return clone(this.data.get(uid) ?? []);
  }

  async transact<T>(uid: string, mutation: (current: WorldAssertion[]) => WorldTransaction<T> | null): Promise<T | null> {
    if (!validUid(uid)) return null;
    const previous = this.queues.get(uid) ?? Promise.resolve();
    let resolveQueue!: () => void;
    const queued = new Promise<void>((resolve) => { resolveQueue = resolve; });
    const tail = previous.catch(() => undefined).then(() => queued);
    this.queues.set(uid, tail);
    await previous.catch(() => undefined);
    try {
      const changed = mutation(clone(this.data.get(uid) ?? []));
      if (!changed || !owned(uid, changed.assertions)) return null;
      this.data.set(uid, clone(changed.assertions));
      return clone(changed.result);
    } finally {
      resolveQueue();
      if (this.queues.get(uid) === tail) this.queues.delete(uid);
    }
  }

  backendName(): string { return "memory-world-state"; }
}

export class LocalFileWorldStateStore implements WorldStateStore {
  private readonly root: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(root = path.join(process.cwd(), "data", "world-state")) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private file(uid: string): string {
    if (!validUid(uid)) throw new Error("LocalFileWorldStateStore: invalid uid");
    return path.join(this.root, `${Buffer.from(uid).toString("base64url")}.json`);
  }

  private read(uid: string): { exists: boolean; document: WorldStateDocument } | null {
    const file = this.file(uid);
    if (!fs.existsSync(file)) return { exists: false, document: { uid, schemaVersion: 1, assertions: [], updatedAt: 0 } };
    try {
      const document = JSON.parse(fs.readFileSync(file, "utf8")) as WorldStateDocument;
      if (document?.uid !== uid || document.schemaVersion !== 1 || !Array.isArray(document.assertions) || !owned(uid, document.assertions)) return null;
      return { exists: true, document };
    } catch { return null; }
  }

  async load(uid: string): Promise<WorldAssertion[] | null> {
    try {
      const read = this.read(uid);
      return read ? clone(read.document.assertions) : null;
    } catch { return null; }
  }

  async transact<T>(uid: string, mutation: (current: WorldAssertion[]) => WorldTransaction<T> | null): Promise<T | null> {
    if (!validUid(uid)) return null;
    const previous = this.queues.get(uid) ?? Promise.resolve();
    let resolveQueue!: () => void;
    const queued = new Promise<void>((resolve) => { resolveQueue = resolve; });
    const tail = previous.catch(() => undefined).then(() => queued);
    this.queues.set(uid, tail);
    await previous.catch(() => undefined);
    try {
      const read = this.read(uid);
      if (!read) return null; // corrupt state is never overwritten
      const changed = mutation(clone(read.document.assertions));
      if (!changed || !owned(uid, changed.assertions)) return null;
      const document: WorldStateDocument = { uid, schemaVersion: 1, assertions: clone(changed.assertions), updatedAt: Date.now() };
      const file = this.file(uid);
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify(document), { encoding: "utf8", flag: "wx" });
        fs.renameSync(temp, file);
      } catch {
        try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
        return null;
      }
      return clone(changed.result);
    } finally {
      resolveQueue();
      if (this.queues.get(uid) === tail) this.queues.delete(uid);
    }
  }

  backendName(): string { return "local-world-state"; }
}
