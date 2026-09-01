import type { FirestoreLike } from "../persistence/firestoreUserStore";
import type { SelfModelDocument } from "./types";
import type { SelfModelStore, SelfModelTransaction } from "./store";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const safeUid = (uid: string): string => {
  if (!uid || uid.length > 128 || uid.includes("/") || uid.includes("\0")) throw new Error("FirestoreSelfModelStore: invalid uid");
  return uid;
};
const empty = (uid: string): SelfModelDocument => ({ uid, schemaVersion: 1, capabilities: [], updatedAt: 0 });
const valid = (uid: string, document: SelfModelDocument): boolean => document?.uid === uid && document.schemaVersion === 1
  && Array.isArray(document.capabilities) && document.capabilities.every((item) => item?.uid === uid);

export class FirestoreSelfModelStore implements SelfModelStore {
  constructor(private db: FirestoreLike, private log: (message: string, error?: unknown) => void = () => undefined) {}
  private path(uid: string): string { return `users/${safeUid(uid)}/selfModel/_root`; }

  async load(uid: string): Promise<SelfModelDocument | null> {
    try {
      const snap = await this.db.doc(this.path(uid)).get();
      if (!snap.exists) return empty(uid);
      const document = snap.data() as SelfModelDocument;
      return valid(uid, document) ? clone(document) : null;
    } catch (error) { this.log("load failed", error); return null; }
  }

  async transact<T>(uid: string, mutation: (current: SelfModelDocument) => SelfModelTransaction<T> | null): Promise<T | null> {
    try {
      const path = this.path(uid);
      return await this.db.runTransaction(async (tx) => {
        const snap = await tx.get({ path });
        const current = snap.exists ? snap.data() as SelfModelDocument : empty(uid);
        if (!valid(uid, current)) return null;
        const changed = mutation(clone(current));
        if (!changed || !valid(uid, changed.document)) return null;
        tx.set({ path }, clone(changed.document));
        return clone(changed.result);
      });
    } catch (error) { this.log("transaction failed", error); return null; }
  }

  backendName(): string { return "firestore-self-model"; }
}

