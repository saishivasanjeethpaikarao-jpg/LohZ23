/**
 * In-memory Firestore mock for tests. Models the subset of Firestore
 * semantics that LOHZ needs: typed docs, transactional batch writes
 * (set+delete atomically), and list-by-collection.
 *
 * This is the standard "fake backend" pattern: tests wire it into
 * `FirestoreUserStoreImpl` and exercise the real implementation.
 */
import type {
  FirestoreCollectionHandle,
  FirestoreConfig,
  FirestoreDocHandle,
  FirestoreLike,
} from "./firestoreUserStore";

interface DocSnapshot {
  exists: boolean;
  data(): unknown;
}

type DocHandle = FirestoreDocHandle;

interface TransactionContext {
  get(ref: { path: string }): Promise<DocSnapshot>;
  set(ref: { path: string }, value: unknown): void;
  delete(ref: { path: string }): void;
}

export interface MockFirestoreOptions {
  /** When set, every operation throws this error — used to simulate Firestore outages. */
  failureMode?: Error | null;
  /** Pre-seed with docs at construction. */
  seed?: Record<string, unknown>;
}

export class MockFirestore implements FirestoreLike {
  private docs = new Map<string, unknown>();
  /** Serialize transactions so concurrent tests model atomic conflict handling. */
  private transactionTail: Promise<void> = Promise.resolve();
  /** Optional simulated-outage toggle that tests can flip on/off. */
  public failureMode: Error | null = null;
  /** Operation log for assertions in tests. */
  public readonly ops: Array<{ op: string; path: string; at: number }> = [];

  constructor(opts: MockFirestoreOptions = {}) {
    if (opts.seed) {
      for (const [path, value] of Object.entries(opts.seed)) {
        this.docs.set(path, value);
      }
    }
    this.failureMode = opts.failureMode ?? null;
  }

  collection(path: string): FirestoreCollectionHandle {
    const prefix = path + "/";
    const firestore = this;
    return {
      listIds: async () => {
        firestore.checkFailure();
        const ids: string[] = [];
        for (const k of firestore.docs.keys()) {
          if (k.startsWith(prefix)) {
            const rest = k.slice(prefix.length);
            if (rest && !rest.includes("/")) ids.push(rest);
          }
        }
        return ids;
      },
      doc: (id: string) => firestore.doc(`${path}/${id}`),
    };
  }

  doc(path: string): DocHandle {
    const firestore = this;
    return {
      async get(): Promise<DocSnapshot> {
        firestore.checkFailure();
        firestore.ops.push({ op: "get", path, at: Date.now() });
        const value = firestore.docs.get(path);
        return value === undefined
          ? { exists: false, data: () => undefined }
          : { exists: true, data: () => firestore.clone(value) };
      },
      async set(value: unknown, opts?: { merge?: boolean }): Promise<void> {
        firestore.checkFailure();
        firestore.ops.push({ op: "set", path, at: Date.now() });
        if (opts?.merge && firestore.docs.has(path)) {
          const existing = firestore.docs.get(path);
          firestore.docs.set(path, { ...(existing as object), ...(value as object) });
        } else {
          firestore.docs.set(path, firestore.clone(value));
        }
      },
      async delete(): Promise<void> {
        firestore.checkFailure();
        firestore.ops.push({ op: "delete", path, at: Date.now() });
        firestore.docs.delete(path);
      },
    };
  }

  async runTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.runSerializedTransaction(fn);
    } finally {
      release();
    }
  }

  private async runSerializedTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.checkFailure();
    const pending = new Map<string, { kind: "set" | "delete"; value?: unknown }>();
    const firestore = this;
    const ctx: TransactionContext = {
      async get(ref: { path: string }): Promise<DocSnapshot> {
        firestore.checkFailure();
        const staged = pending.get(ref.path);
        if (staged?.kind === "delete") return { exists: false, data: () => undefined };
        if (staged?.kind === "set") return { exists: true, data: () => firestore.clone(staged.value) };
        const value = firestore.docs.get(ref.path);
        return value === undefined
          ? { exists: false, data: () => undefined }
          : { exists: true, data: () => firestore.clone(value) };
      },
      set(ref: { path: string }, value: unknown): void {
        pending.set(ref.path, { kind: "set", value: firestore.clone(value) });
      },
      delete(ref: { path: string }): void {
        pending.set(ref.path, { kind: "delete" });
      },
    };
    const result = await fn(ctx);
    for (const [path, op] of pending) {
      if (op.kind === "set") firestore.docs.set(path, op.value);
      else firestore.docs.delete(path);
    }
    return result;
  }

  private checkFailure(): void {
    if (this.failureMode) throw this.failureMode;
  }

  private clone(value: unknown): unknown {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
}

export function makeMockFirestoreConfig(opts: MockFirestoreOptions = {}): FirestoreConfig {
  return { db: new MockFirestore(opts), log: () => undefined };
}
