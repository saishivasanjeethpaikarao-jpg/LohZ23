/**
 * Phase 27 — bounded entity extraction (§5).
 *
 * Only the closed entity set from types.ts is produced. App names come
 * from a known-list plus a conservative capitalized-token fallback;
 * URLs/volumes/files/text use anchored patterns.
 */
import type { RouteEntities } from "./types";

export const KNOWN_APPS = [
  "visual studio code", "vs code", "vscode", "code",
  "google chrome", "chrome",
  "microsoft edge", "edge",
  "mozilla firefox", "firefox",
  "file explorer", "explorer",
  "calculator", "calc",
  "notepad", "spotify",
  "terminal", "powershell", "cmd", "command prompt",
  "outlook", "teams", "slack", "discord", "word", "excel", "powerpoint",
];

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/i;

export const POPULAR_SITES: Record<string, string> = {
  youtube: "https://www.youtube.com",
  google: "https://www.google.com",
  github: "https://github.com",
  twitter: "https://x.com",
  x: "https://x.com",
  reddit: "https://www.reddit.com",
  netflix: "https://www.netflix.com",
  chatgpt: "https://chatgpt.com",
  gmail: "https://mail.google.com",
  facebook: "https://www.facebook.com",
  instagram: "https://www.instagram.com",
  linkedin: "https://www.linkedin.com",
  amazon: "https://www.amazon.com",
  wikipedia: "https://www.wikipedia.org",
  spotify: "https://open.spotify.com",
};

export function extractAppName(text: string): string | undefined {
  for (const app of KNOWN_APPS) {
    const re = new RegExp(`\\b${app.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(text)) return canonicalAppName(app);
  }
  // Conservative fallback: a capitalized token right after open/close/focus/start/launch.
  const m = text.match(/\b(?:open|close|focus|start|launch|kill|quit)\s+([A-Z][\w-]*)\b/);
  return m?.[1] ? canonicalAppName(m[1]) : undefined;
}

/** Map common aliases to registry tool args (openApp uses lowercase names). */
export function canonicalAppName(app: string): string {
  const lower = app.trim().toLowerCase();
  if (lower === "vscode" || lower === "vs code" || lower === "visual studio code" || lower === "vs") return "code";
  if (lower === "google chrome") return "chrome";
  if (lower === "microsoft edge") return "edge";
  if (lower === "file explorer") return "explorer";
  if (lower === "calc") return "calculator";
  if (lower === "command prompt") return "cmd";
  return lower;
}

export function extractUrl(text: string): string | undefined {
  const m = text.match(URL_PATTERN);
  if (m) return m[0];
  // Bare domain like "open github.com"
  const bare = text.match(/\b((?:www\.)?[a-z0-9-]+\.(?:com|org|net|io|dev|ai|app|co|tv))\b\/?\S*/i);
  if (bare) return `https://${bare[1]}`;
  // Popular website name match: e.g. "open youtube", "open youtube on chrome"
  for (const [site, siteUrl] of Object.entries(POPULAR_SITES)) {
    const re = new RegExp(`\\b${site}\\b`, "i");
    if (re.test(text)) return siteUrl;
  }
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
