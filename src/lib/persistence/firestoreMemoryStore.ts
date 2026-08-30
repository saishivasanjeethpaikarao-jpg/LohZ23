/**
 * Firestore-backed implementation of `MemoryStore`.
 *
 * Delegates to `FirestoreUserStore` — never touches firebase-admin
 * directly so the abstraction surface stays clean. Re-stamps the
 * authenticated uid on every write to make cross-user writes
 * structurally impossible.
 */
import type { Memory } from "../memoryTypes";
import type { MemoryStore } from "./memoryStore";
import type { FirestoreUserStore } from "./firestoreUserStore";

export class FirestoreMemoryStore implements MemoryStore {
  constructor(
    private readonly store: FirestoreUserStore,
    private readonly uid: string
  ) {
    if (!uid) throw new Error("FirestoreMemoryStore: uid is required");
  }

  async load(uid: string): Promise<Memory[] | null> {
    if (uid !== this.uid) return null; // refuse cross-uid reads
    return this.store.listMemories(this.uid);
  }

  async save(uid: string, memories: Memory[]): Promise<boolean> {
    if (uid !== this.uid) return false;
    return this.store.replaceMemories(this.uid, memories);
  }

  async add(uid: string, memory: Memory): Promise<boolean> {
    if (uid !== this.uid) return false;
    if (!memory || memory.metadata.userId !== this.uid) return false;
    return this.store.putMemory(this.uid, memory);
  }

  async delete(uid: string, memoryId: string): Promise<boolean> {
    if (uid !== this.uid) return false;
    return this.store.deleteMemory(this.uid, memoryId);
  }

  async isHealthy(): Promise<boolean> {
    return this.store.isHealthy();
  }

  backendName(): string {
    return "firestore";
  }
}
