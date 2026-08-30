/**
 * One-shot migration: `data/memories/{uid}.json` → Firestore.
 *
 * - Source-of-truth remains the local file until migration succeeds.
 * - After successful write + receipt write, the source file is moved to
 *   `data/memories/.archive/{uid}.{timestamp}.json` (NOT deleted) so we
 *   have a paper trail. The receipt doc is the canonical dedup signal.
 * - Re-running is a no-op: receipt exists → skip.
 * - Partial failure: nothing is moved; next run retries cleanly.
 *
 * No API keys are persisted to Firestore at any point. The user's
 * encrypted credentialStore remains on disk.
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { Memory } from "../memoryTypes";
import type { FirestoreUserStore, MigrationReceipt } from "./firestoreUserStore";

const MEMORY_DIR = path.join(process.cwd(), "data", "memories");
const ARCHIVE_DIR = path.join(MEMORY_DIR, ".archive");
const SOURCE_NAME = "localMemoryV1";

function safeUid(uid: string): string {
  return uid.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadLocalMemories(uid: string): Promise<Memory[]> {
  const file = path.join(MEMORY_DIR, `${safeUid(uid)}.json`);
  try {
    const data = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed as Memory[];
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

function fingerprint(memories: Memory[]): string {
  const hasher = crypto.createHash("sha256");
  const ids = memories
    .map((m) => ({ id: m.id, updatedAt: m.updatedAt }))
    .sort((a, b) => a.id.localeCompare(b.id));
  hasher.update(JSON.stringify(ids));
  return hasher.digest("hex").slice(0, 16);
}

export interface MigrationResult {
  uid: string;
  migratedCount: number;
  alreadyMigrated: boolean;
  skipped: boolean;
  receipt: MigrationReceipt | null;
  error?: string;
}

/**
 * Migrate one user's local memory file to Firestore.
 * Returns a structured result so callers (CLI / startup / test) can
 * report status without throwing.
 */
export async function migrateLocalMemoryToFirestore(
  uid: string,
  store: FirestoreUserStore
): Promise<MigrationResult> {
  if (!uid) return { uid, migratedCount: 0, alreadyMigrated: false, skipped: true, receipt: null, error: "missing uid" };

  // 1. Receipt dedup
  const existing = await store.getMigrationReceipt(uid, SOURCE_NAME);
  if (existing) {
    return { uid, migratedCount: existing.sourceCount, alreadyMigrated: true, skipped: true, receipt: existing };
  }

  // 2. Read source
  const memories = await loadLocalMemories(uid);
  if (memories.length === 0) {
    // Nothing to migrate; record receipt so we don't keep probing.
    const emptyReceipt: MigrationReceipt = {
      source: SOURCE_NAME,
      sourceCount: 0,
      fingerprint: fingerprint([]),
      migratedAt: Date.now(),
    };
    await store.recordMigrationReceipt(uid, SOURCE_NAME, emptyReceipt);
    return { uid, migratedCount: 0, alreadyMigrated: false, skipped: false, receipt: emptyReceipt };
  }

  // 3. Stamp every memory with the authenticated uid BEFORE writing.
  const stamped = memories.map((m) => ({
    ...m,
    metadata: { ...m.metadata, userId: uid },
  }));

  // 4. Ensure profile exists (best-effort).
  await store.ensureProfile(uid);

  // 5. Atomic write via replaceMemories.
  const ok = await store.replaceMemories(uid, stamped);
  if (!ok) {
    return {
      uid,
      migratedCount: 0,
      alreadyMigrated: false,
      skipped: false,
      receipt: null,
      error: "firestore write failed",
    };
  }

  // 6. Receipt
  const receipt: MigrationReceipt = {
    source: SOURCE_NAME,
    sourceCount: stamped.length,
    fingerprint: fingerprint(stamped),
    migratedAt: Date.now(),
  };
  await store.recordMigrationReceipt(uid, SOURCE_NAME, receipt);

  // 7. Verify the write by reading back.
  const back = await store.listMemories(uid);
  if (!back || back.length !== stamped.length) {
    return {
      uid,
      migratedCount: 0,
      alreadyMigrated: false,
      skipped: false,
      receipt: null,
      error: "post-migration verification failed",
    };
  }

  // 8. Archive the source file (move, not delete).
  try {
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });
    const src = path.join(MEMORY_DIR, `${safeUid(uid)}.json`);
    const dst = path.join(ARCHIVE_DIR, `${safeUid(uid)}.${receipt.migratedAt}.json`);
    if (await fileExists(src)) {
      await fs.rename(src, dst);
    }
  } catch (e) {
    // Archive failure is non-fatal — Firestore is the source of truth now.
    console.warn(`[migration] could not archive ${uid}.json:`, e);
  }

  return { uid, migratedCount: stamped.length, alreadyMigrated: false, skipped: false, receipt };
}

/**
 * Walk every `data/memories/*.json` (top-level files only — `.archive/*`
 * is excluded) and migrate each.
 */
export async function migrateAllLocalMemories(
  store: FirestoreUserStore
): Promise<MigrationResult[]> {
  try {
    await fs.mkdir(MEMORY_DIR, { recursive: true });
    const entries = await fs.readdir(MEMORY_DIR, { withFileTypes: true });
    const out: MigrationResult[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      // entry.name may already be a sanitized uid; pass through unchanged.
      const uid = entry.name.replace(/\.json$/, "");
      if (uid.startsWith(".")) continue; // skip .archive marker etc.
      out.push(await migrateLocalMemoryToFirestore(uid, store));
    }
    return out;
  } catch (e) {
    console.error("[migration] directory scan failed:", e);
    return [];
  }
}
