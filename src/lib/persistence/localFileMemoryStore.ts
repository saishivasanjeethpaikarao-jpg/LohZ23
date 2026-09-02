/**
 * Local JSON-file implementation of `MemoryStore`. Preserves the
 * pre-Firestore behavior: per-user file under `data/memories/{uid}.json`.
 *
 * Used by:
 * - existing tests that depend on file-backed semantics
 * - the migration source-of-truth (read once, write to Firestore, archive)
 * - offline fall-back when Firestore is unavailable
 */
import fs from "fs/promises";
import path from "path";
import type { Memory } from "../memoryTypes";
import type { MemoryStore } from "./memoryStore";
import { runtimeDataRoot } from "../runtimePaths";

const MEMORY_DIR = runtimeDataRoot("memories");

function safeUid(uid: string): string {
  if (!uid || uid.includes("/") || uid.includes("..") || uid.includes("\0")) {
    throw new Error("LocalFileMemoryStore: invalid uid");
  }
  return uid.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function pathFor(dir: string, uid: string): string {
  return path.join(dir, `${safeUid(uid)}.json`);
}

export class LocalFileMemoryStore implements MemoryStore {
  private dir: string;
  private mutations = new Map<string, Promise<void>>();
  constructor(dir: string = MEMORY_DIR) {
    this.dir = dir;
  }

  private fileFor(uid: string): string {
    return pathFor(this.dir, uid);
  }

  async load(uid: string): Promise<Memory[] | null> {
    try {
      const data = await fs.readFile(this.fileFor(uid), "utf-8");
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      // Enforce per-user isolation defensively — drop any foreign entries.
      return (parsed as Memory[]).filter((m) => m?.metadata?.userId === uid);
    } catch (e: any) {
      if (e?.code === "ENOENT") return [];
      console.error("[LocalFileMemoryStore] load failed:", e);
      return null;
    }
  }

  private async saveNow(uid: string, memories: Memory[]): Promise<boolean> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      // Defensive per-user stamp — refuse to persist foreign records.
      const stamped = memories.map((m) => ({
        ...m,
        metadata: { ...m.metadata, userId: uid },
      }));
      await fs.writeFile(this.fileFor(uid), JSON.stringify(stamped, null, 2), "utf-8");
      return true;
    } catch (e) {
      console.error("[LocalFileMemoryStore] save failed:", e);
      return false;
    }
  }

  private enqueue<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(uid) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(fn);
    const marker = work.then(() => undefined, () => undefined);
    this.mutations.set(uid, marker);
    return work.finally(() => {
      if (this.mutations.get(uid) === marker) this.mutations.delete(uid);
    });
  }

  async save(uid: string, memories: Memory[]): Promise<boolean> {
    return this.enqueue(uid, () => this.saveNow(uid, memories));
  }

  async add(uid: string, memory: Memory): Promise<boolean> {
    if (!memory || memory.metadata.userId !== uid) return false;
    return this.enqueue(uid, async () => {
      const existing = await this.load(uid);
      if (existing === null) return false;
      if (existing.some((m) => m.id === memory.id)) return true;
      existing.push(memory);
      return this.saveNow(uid, existing);
    });
  }

  async delete(uid: string, memoryId: string): Promise<boolean> {
    return this.enqueue(uid, async () => {
      const existing = await this.load(uid);
      if (existing === null) return false;
      const next = existing.filter((m) => m.id !== memoryId);
      return this.saveNow(uid, next);
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.access(this.dir);
      return true;
    } catch {
      return false;
    }
  }

  backendName(): string {
    return `local-file:${this.dir}`;
  }
}
