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

const MEMORY_DIR = path.join(process.cwd(), "data", "memories");

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

  async save(uid: string, memories: Memory[]): Promise<boolean> {
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

  async add(uid: string, memory: Memory): Promise<boolean> {
    if (!memory || memory.metadata.userId !== uid) return false;
    const existing = (await this.load(uid)) ?? [];
    if (existing.some((m) => m.id === memory.id)) return true;
    existing.push(memory);
    return this.save(uid, existing);
  }

  async delete(uid: string, memoryId: string): Promise<boolean> {
    const existing = (await this.load(uid)) ?? [];
    const next = existing.filter((m) => m.id !== memoryId);
    return this.save(uid, next);
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
