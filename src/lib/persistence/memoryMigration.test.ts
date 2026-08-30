import { describe, it, expect, afterEach } from "vitest";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { FirestoreUserStoreImpl } from "./firestoreUserStore";
import { MockFirestore } from "./mockFirestore";
import {
  migrateLocalMemoryToFirestore,
} from "./memoryMigration";
import type { Memory } from "../memoryTypes";

const MEMORY_DIR = path.join(process.cwd(), "data", "memories");
const ARCHIVE_DIR = path.join(MEMORY_DIR, ".archive");
const TEST_UID = "migration_test_user_22";
const SOURCE_FILE = path.join(MEMORY_DIR, `${TEST_UID}.json`);

function makeLegacyMemory(uid: string, id: string, text: string): Memory {
  const ts = new Date().toISOString();
  return {
    id,
    layer: "semantic",
    category: "identity",
    text,
    createdAt: ts,
    updatedAt: ts,
    metadata: {
      importance: 0.6,
      confidence: 0.9,
      source: "conversation",
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      lastReinforced: Date.now(),
      category: "identity",
      relationships: [],
      userId: uid,
    },
  };
}

async function writeSourceFile(memories: Memory[]): Promise<void> {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
  await fs.writeFile(SOURCE_FILE, JSON.stringify(memories, null, 2));
}

async function cleanup(): Promise<void> {
  for (const p of [SOURCE_FILE]) {
    if (existsSync(p)) await fs.rm(p);
  }
  if (existsSync(ARCHIVE_DIR)) {
    for (const f of await fs.readdir(ARCHIVE_DIR)) {
      if (f.startsWith(TEST_UID)) await fs.rm(path.join(ARCHIVE_DIR, f));
    }
  }
}

describe("local JSON → Firestore memory migration", () => {
  afterEach(cleanup);

  it("migrates a local file to Firestore and archives (not deletes) the source", async () => {
    await writeSourceFile([
      makeLegacyMemory(TEST_UID, "m1", "Prefers dark mode"),
      makeLegacyMemory(TEST_UID, "m2", "Works on lohz project"),
    ]);

    const db = new MockFirestore();
    const store = new FirestoreUserStoreImpl({ db, log: () => undefined });

    const result = await migrateLocalMemoryToFirestore(TEST_UID, store);
    expect(result.error).toBeUndefined();
    expect(result.skipped).toBe(false);
    expect(result.migratedCount).toBe(2);
    expect(result.receipt).not.toBeNull();
    expect(result.receipt!.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    // Source file archived, not deleted
    expect(existsSync(SOURCE_FILE)).toBe(false);
    const archives = await fs.readdir(ARCHIVE_DIR);
    expect(archives.some((f) => f.startsWith(TEST_UID)));

    // Data lives in Firestore, stamped with the uid
    const remote = await store.listMemories(TEST_UID);
    expect(remote).toHaveLength(2);
    expect(remote!.every((m) => m.metadata.userId === TEST_UID)).toBe(true);

    // Profile created as part of migration
    const profile = await store.getProfile(TEST_UID);
    expect(profile!.uid).toBe(TEST_UID);
  });

  it("is idempotent — second run sees the receipt and does nothing", async () => {
    await writeSourceFile([makeLegacyMemory(TEST_UID, "m1", "One")]);

    const db = new MockFirestore();
    const store = new FirestoreUserStoreImpl({ db, log: () => undefined });

    const first = await migrateLocalMemoryToFirestore(TEST_UID, store);
    expect(first.skipped).toBe(false);

    // Simulate a "new" local write AFTER migration (recreate source file)
    await writeSourceFile([makeLegacyMemory(TEST_UID, "m999", "Should NOT migrate")]);

    const second = await migrateLocalMemoryToFirestore(TEST_UID, store);
    expect(second.skipped).toBe(true);
    expect(second.alreadyMigrated).toBe(true);
    expect(second.migratedCount).toBe(1);

    // Firestore still has only the original doc
    expect(await store.listMemories(TEST_UID)).toHaveLength(1);
  });

  it("records an empty receipt and skips when the source file is missing", async () => {
    const db = new MockFirestore();
    const store = new FirestoreUserStoreImpl({ db, log: () => undefined });

    const result = await migrateLocalMemoryToFirestore(TEST_UID, store);
    expect(result.skipped).toBe(false);
    expect(result.migratedCount).toBe(0);
    expect(result.receipt!.sourceCount).toBe(0);
  });

  it("never touches the source file when the Firestore write fails", async () => {
    await writeSourceFile([makeLegacyMemory(TEST_UID, "m1", "Valuable memory")]);

    const db = new MockFirestore();
    const store = new FirestoreUserStoreImpl({ db, log: () => undefined });
    db.failureMode = new Error("firestore is down");

    const result = await migrateLocalMemoryToFirestore(TEST_UID, store);
    expect(result.error).toBeDefined();
    expect(result.migratedCount).toBe(0);
    expect(result.receipt).toBeNull();

    // Source file untouched — user data NOT lost
    expect(existsSync(SOURCE_FILE)).toBe(true);

    // No receipt recorded — a retry can proceed later
    db.failureMode = null;
    expect(await store.getMigrationReceipt(TEST_UID, "localMemoryV1")).toBeNull();
  });

  it("fails without a uid instead of guessing", async () => {
    const db = new MockFirestore();
    const store = new FirestoreUserStoreImpl({ db, log: () => undefined });
    const result = await migrateLocalMemoryToFirestore("", store);
    expect(result.error).toBe("missing uid");
    expect(result.skipped).toBe(true);
  });

  it("cannot write another user's data into the wrong namespace mid-migration", async () => {
    // Legacy file stamped with a foreign uid in metadata — migration re-stamps
    // to the authenticated uid so isolation holds end to end.
    await writeSourceFile([makeLegacyMemory("attacker_uid", "m1", "spoofed")]);

    const db = new MockFirestore();
    const store = new FirestoreUserStoreImpl({ db, log: () => undefined });

    const result = await migrateLocalMemoryToFirestore(TEST_UID, store);
    expect(result.error).toBeUndefined();
    const remote = await store.listMemories(TEST_UID);
    expect(remote).toHaveLength(1);
    expect(remote![0].metadata.userId).toBe(TEST_UID);
    // The attacker's namespace stays empty
    expect(await store.listMemories("attacker_uid")).toHaveLength(0);
  });
});
