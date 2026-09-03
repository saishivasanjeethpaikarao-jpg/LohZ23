/**
 * Desktop Authentication Session Store
 *
 * Stores one-time authorization codes for the desktop OAuth-style handoff.
 * Each code is:
 *   - Bound to a PKCE-style state parameter (prevents CSRF)
 *   - Single-use (consumed immediately on first exchange)
 *   - Short-lived (TTL: 300 seconds)
 *   - Replay-protected (consumed codes are not re-accepted)
 *
 * This is an in-memory store. For multi-instance deployments, replace with
 * a Redis/Firestore-backed equivalent.
 */

import crypto from "crypto";

export interface AuthCode {
  code: string;
  state: string;
  /** Unix epoch ms when this code expires */
  expiresAt: number;
  /** True once the code has been successfully consumed */
  consumed: boolean;
}

const CODE_TTL_MS = 300_000; // 5 minutes
const CODE_LENGTH_BYTES = 32;
const STATE_LENGTH_BYTES = 32;

/** All live (and recently consumed) codes, keyed by code string */
const store = new Map<string, AuthCode>();

/** Sweep expired entries to prevent unbounded memory growth */
function sweep(): void {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    // Keep consumed entries for 10 s (replay protection window) then remove
    const retentionDeadline = entry.consumed ? entry.expiresAt + 10_000 : entry.expiresAt;
    if (now > retentionDeadline) store.delete(key);
  }
}

/**
 * Issue a new one-time authorization code + state pair.
 * Returns { code, state } — both values must be communicated to the browser.
 */
export function issueAuthCode(): { code: string; state: string } {
  sweep();
  const code = crypto.randomBytes(CODE_LENGTH_BYTES).toString("hex");
  const state = crypto.randomBytes(STATE_LENGTH_BYTES).toString("hex");
  store.set(code, { code, state, expiresAt: Date.now() + CODE_TTL_MS, consumed: false });
  return { code, state };
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "consumed" | "state_mismatch" };

/**
 * Consume a one-time code + state pair.
 * Returns { ok: true } exactly once. All subsequent calls for the same code
 * return { ok: false, reason: "consumed" } even if timing allows it.
 */
export function consumeAuthCode(code: string, state: string): ConsumeResult {
  sweep();

  if (!code || !state) return { ok: false, reason: "not_found" };

  const entry = store.get(code);
  if (!entry) return { ok: false, reason: "not_found" };
  if (Date.now() > entry.expiresAt) {
    store.delete(code);
    return { ok: false, reason: "expired" };
  }
  if (entry.consumed) return { ok: false, reason: "consumed" };

  // Constant-time state comparison (prevents timing oracle)
  const expectedBuf = Buffer.from(entry.state, "utf8");
  const actualBuf = Buffer.from(state, "utf8");
  const stateMatch =
    expectedBuf.length === actualBuf.length &&
    crypto.timingSafeEqual(expectedBuf, actualBuf);
  if (!stateMatch) return { ok: false, reason: "state_mismatch" };

  // Mark consumed BEFORE returning success (atomic replay protection)
  entry.consumed = true;
  return { ok: true };
}

/** Test-only reset */
export function _resetSessionStoreForTests(): void {
  store.clear();
}
