/**
 * Deterministic text fingerprinting for memory dedup.
 *
 * Pure functions — no model calls, no I/O. Two fingerprints collide only
 * when the underlying texts are lexically near-identical after
 * normalization (case, punctuation, stopwords removed). Semantic
 * paraphrase is handled separately by `MemoryDedupe`'s token-overlap
 * similarity above it.
 */
import crypto from "crypto";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "i", "you", "he", "she", "it", "we", "they", "me", "my", "your",
  "his", "her", "its", "our", "their", "this", "that", "these", "those",
  "to", "of", "in", "on", "at", "for", "with", "as", "by", "from",
  "and", "or", "but", "not", "no", "so", "if", "then", "than", "too",
  "very", "just", "really", "also", "about", "do", "does", "did",
  "have", "has", "had", "will", "would", "could", "should", "can",
  "my", "favorite", "favourite", "prefer", "like", "love",
  // contraction residues after punctuation stripping
  "don", "doesn", "didn", "isn", "aren", "wasn", "weren", "won",
  "wouldn", "couldn", "shouldn", "can", "cant", "havent", "hasn",
  "hadn", "didnt", "doesnt", "isnt", "arent", "wasnt", "werent",
  "wont", "wouldnt", "couldnt", "shouldnt", "cannot",
]);

export interface NormalizedText {
  normalized: string;      // lowercase, punctuation-stripped, collapsed
  tokens: string[];        // stopwords removed, sorted, unique
  content: string;         // tokens joined with single spaces
}

export function normalizeText(text: string): NormalizedText {
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = [...new Set(
    normalized
      .split(" ")
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
  )].sort();

  return { normalized, tokens, content: tokens.join(" ") };
}

/**
 * Deterministic fingerprint: sha1 over sorted content tokens.
 * Two texts normalize to the same fingerprint iff they share the exact
 * same non-stopword token set (order-insensitive).
 */
export function fingerprint(text: string): string {
  const n = normalizeText(text);
  return crypto.createHash("sha1").update(n.content).digest("hex").slice(0, 16);
}

/** Jaccard similarity over normalized token sets, 0..1. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeText(a).tokens);
  const tb = new Set(normalizeText(b).tokens);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}

/**
 * Negation-polarity: whether the text asserts or negates its content.
 * Used by contradiction detection to distinguish "likes X" vs "hates X".
 */
const NEGATIVE_MARKER_PATTERN = /\b(dont|doesnt|didnt|cant|hates?|dislikes?|not|never|stops?|stopped|stopping|quits?|quitting|avoids?|avoided|avoiding|tired|boring|annoying)\b/i;
const POSITIVE_MARKER_PATTERN = /\b(loves?|loved|loving|enjoys?|enjoyed|enjoying|great|best|awesome|amazing|fantastic|brilliant|excellent|wonderful|prefers?|preferred|preferring)\b/i;

export function polarity(text: string): "positive" | "negative" | "neutral" {
  const lower = text
    .toLowerCase()
    .replace(/['’]/g, "") // strip apostrophes, so "don't" → "dont", "can't" → "cant"
    .trim();
  const hasNeg = NEGATIVE_MARKER_PATTERN.test(lower);
  const hasPos = POSITIVE_MARKER_PATTERN.test(lower);
  if (hasNeg && !hasPos) return "negative";
  if (hasPos && !hasNeg) return "positive";
  return "neutral";
}

/** Extract the subject/object "content words" for duplicate comparison. */
export function contentWords(text: string): string[] {
  return normalizeText(text).tokens;
}
