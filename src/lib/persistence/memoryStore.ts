/**
 * Storage-agnostic memory interface so server_memory.ts can switch between
 * the local JSON-file backend and the Firestore backend without changing
 * call sites. All implementations MUST enforce per-user isolation: a
 * write/read for user A never affects user B.
 *
 * Implementations: see `LocalFileMemoryStore` (file-based) and
 * `FirestoreMemoryStore` (Firestore-backed). The local impl is the
 * historical default; the Firestore one is the production target.
 */
import type { Memory } from "../memoryTypes";

export interface MemoryStore {
  /** Load all memories for `uid`. Returns [] for unknown user; null on failure. */
  load(uid: string): Promise<Memory[] | null>;
  /** Persist the full memory list for `uid` atomically. */
  save(uid: string, memories: Memory[]): Promise<boolean>;
  /**
   * Atomically add a single memory. Refuses if `memory.metadata.userId` does
   * not match `uid` — prevents cross-user writes by construction.
   */
  add(uid: string, memory: Memory): Promise<boolean>;
  /** Atomically delete a memory. Returns true on success or unknown id. */
  delete(uid: string, memoryId: string): Promise<boolean>;
  /** Quick health probe — true means the backend is reachable. */
  isHealthy(): Promise<boolean>;
  /** A short, human-readable backend label for logs. */
  backendName(): string;
}
