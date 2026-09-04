/**
 * Phase 27 — deterministic input normalization (§4).
 *
 * Strips case, punctuation, wake-word prefixes, and politeness filler
 * WITHOUT removing meaningful entities. Pure string math.
 */

const WAKE_PREFIXES = [
  /^(?:hey|ok|okay|yo|hi|hello)\s+lohz[,:!]?\s*/i,
  /^lohz[,:!]?\s+/i,
];

const POLITENESS = [
  /^(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?(?:kindly\s+)?/i,
  /^(?:please|kindly)\s+/i,
  /^(?:i\s+want\s+you\s+to|i\s+need\s+you\s+to|help\s+me|let's|lets|go\s+ahead\s+and)\s+/i,
  /\s+(?:please|kindly)\s*[.!?]*$/i,
  /\s+for\s+me\s*[.!?]*$/i,
  /\s+(?:right\s+)?now\s*[.!?]*$/i,
];

const LEADING_FILLERS = [/^(?:um+|uh+|so|hey|okay|ok|well|just)[.,!\s]+/i];

export function normalizeInput(raw: string): string {
  let t = raw.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of [...WAKE_PREFIXES, ...POLITENESS, ...LEADING_FILLERS]) {
      const next = t.replace(re, "").trim();
      if (next !== t) { t = next; changed = true; }
    }
  }
  return t;
}

/** Normalized text with trailing punctuation removed for matching. */
export function matchable(text: string): string {
  return normalizeInput(text).replace(/[?.!]+$/g, "").trim();
}
