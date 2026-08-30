/**
 * Phase 27 — bounded entity extraction (§5).
 *
 * Only the closed entity set from types.ts is produced. App names come
 * from a known-list plus a conservative capitalized-token fallback;
 * URLs/volumes/files/text use anchored patterns.
 */
import type { RouteEntities } from "./types";

export const KNOWN_APPS = [
  "chrome", "edge", "firefox", "calculator", "notepad", "explorer",
  "spotify", "code", "vscode", "terminal", "powershell", "cmd",
  "outlook", "teams", "slack", "discord", "word", "excel", "powerpoint",
];

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/i;

function extractAppName(text: string): string | undefined {
  for (const app of KNOWN_APPS) {
    const re = new RegExp(`\\b${app}\\b`, "i");
    if (re.test(text)) return canonicalAppName(app);
  }
  // Conservative fallback: a capitalized token right after open/close/focus/start/launch.
  const m = text.match(/\b(?:open|close|focus|start|launch|kill|quit)\s+([A-Z][\w-]*)\b/);
  return m?.[1] ? m[1].toLowerCase() : undefined;
}

/** Map common aliases to registry tool args (openApp uses lowercase names). */
export function canonicalAppName(app: string): string {
  const lower = app.toLowerCase();
  if (lower === "vscode") return "code";
  return lower;
}

export function extractUrl(text: string): string | undefined {
  const m = text.match(URL_PATTERN);
  if (m) return m[0];
  // Bare domain like "open github.com"
  const bare = text.match(/\b((?:www\.)?[a-z0-9-]+\.(?:com|org|net|io|dev|ai))\b\/?\S*/i);
  if (bare) return `https://${bare[1]}`;
  return undefined;
}

export function extractVolume(text: string): number | undefined {
  const digit = text.match(/\b(?:to\s+)?(\d{1,3})\s*%?(?:\s*(?:percent|volume))?/i);
  if (digit) {
    const n = parseInt(digit[1], 10);
    return n >= 0 && n <= 100 ? n : undefined;
  }
  for (const [word, val] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\bto\\s+${word}\\b`, "i").test(text)) return val;
  }
  return undefined;
}

const FILE_PATH = /(?:[A-Za-z]:\\[^\s"']+|\/(?:[\w.-]+\/)+[\w.-]+)/;

export function extractFilePath(text: string): string | undefined {
  return text.match(FILE_PATH)?.[0];
}

/**
 * Quoted payload for clipboard_write / generic text entities.
 * Supports "..." '...' and trailing colon forms.
 */
export function extractQuotedText(text: string): string | undefined {
  const dq = text.match(/"([^"]{1,500})"/) ?? text.match(/'([^']{1,500})'/);
  if (dq) return dq[1];
  const colon = text.match(/:\s*(.{1,300})$/);
  return colon?.[1]?.trim() || undefined;
}

export function extractEntities(text: string): RouteEntities {
  const out: RouteEntities = {};
  const app = extractAppName(text);
  if (app) out.appName = app;
  const url = extractUrl(text);
  if (url) out.url = url;
  const vol = extractVolume(text);
  if (vol !== undefined) out.volumeLevel = vol;
  const file = extractFilePath(text);
  if (file) out.filePath = file;
  return out;
}
