import type { FirestoreLike } from "../persistence/firestoreUserStore";
import type { WorldAssertion, WorldStateDocument } from "./types";
import type { WorldStateStore, WorldTransaction } from "./store";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function safeUid(uid: string): string {
  if (!uid || uid.length > 128 || uid.includes("/") || uid.includes("\0")) throw new Error("FirestoreWorldStateStore: invalid uid");
  return uid;
}

export class FirestoreWorldStateStore implements WorldStateStore {
  constructor(
    private readonly db: FirestoreLike,
    private readonly log: (message: string, error?: unknown) => void = (message, error) => console.warn(`[firestore-world] ${message}`, error ?? ""),
  ) {}

  private path(uid: string): string { return `users/${safeUid(uid)}/worldState/_root`; }

  async load(uid: string): Promise<WorldAssertion[] | null> {
    try {
      const snap = await this.db.doc(this.path(uid)).get();
      if (!snap.exists) return [];
      const document = snap.data() as WorldStateDocument;
      if (document?.uid !== uid || document.schemaVersion !== 1 || !Array.isArray(document.assertions)) return null;
      if (document.assertions.some((item) => item?.uid !== uid)) return null;
      return clone(document.assertions);
    } catch (error) { this.log("load failed", error); return null; }
  }

  async transact<T>(uid: string, mutation: (current: WorldAssertion[]) => WorldTransaction<T> | null): Promise<T | null> {
    try {
      const path = this.path(uid);
      return await this.db.runTransaction(async (tx) => {
        const snap = await tx.get({ path });
        let current: WorldAssertion[] = [];
        if (snap.exists) {
          const document = snap.data() as WorldStateDocument;
          if (document?.uid !== uid || document.schemaVersion !== 1 || !Array.isArray(document.assertions)) return null;
          if (document.assertions.some((item) => item?.uid !== uid)) return null;
          current = clone(document.assertions);
        }
        const changed = mutation(current);
        if (!changed || changed.assertions.some((item) => item?.uid !== uid)) return null;
        tx.set({ path }, { uid, schemaVersion: 1, assertions: clone(changed.assertions), updatedAt: Date.now() } satisfies WorldStateDocument);
        return clone(changed.result);
      });
    } catch (error) { this.log("transaction failed", error); return null; }
  }

  backendName(): string { return "firestore-world-state"; }
}
