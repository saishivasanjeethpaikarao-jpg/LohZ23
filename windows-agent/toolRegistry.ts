/**
 * Tool registry — the single source of truth for every Windows Agent tool.
 *
 * The main server's toolRouter imports this same module to build Gemini function
 * declarations, so the Gemini-exposed surface and the agent-executable surface
 * stay synchronized.
 */
import type { ParamSchema, RiskLevel, ToolDefinition } from "./types";
import { closeApp, focusApp, openApp, knownAppNames, isKnownAppName } from "./tools/applications";
import { openUrl } from "./tools/browser";
import {
  createFile,
  createFolder,
  readFile,
  renameFile,
  writeFile,
} from "./tools/files";
import {
  focusWindow,
  listWindows,
  maximizeWindow,
  minimizeWindow,
} from "./tools/windows";
import { clipboardRead, clipboardWrite } from "./tools/clipboard";
import { takeScreenshot } from "./tools/screenshot";
import { getSystemInfo, getVolume, setVolume } from "./tools/system";
import { isPublicHostname, isSafeBasename, LIMITS } from "./utils/validation";

function stringProp(desc: string, enumValues?: string[]): ParamSchema {
  const p: ParamSchema = { type: "STRING", description: desc };
  if (enumValues) p.enum = enumValues;
  return p;
}

function pathTextValid(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim() || value.length > 500) return false;
  return !value.split(/[\\/]+/).includes("..");
}

const APP_NAME_PROP = stringProp(
  `Application name. Allowed values: ${knownAppNames().join(", ")}.`,
  knownAppNames()
);

const TOOLS: ToolDefinition[] = [
  {
    name: "openApp",
    description:
      "Opens a known desktop application by friendly name. Restricted to a whitelist: " +
      knownAppNames().join(", ") +
      ". Do NOT use for shell commands, scripts, or unknown executables.",
    category: "applications",
    risk: "LOW" as RiskLevel,
    timeoutMs: 12000,
    parameters: {
      type: "OBJECT",
      required: ["name"],
      properties: { name: APP_NAME_PROP },
    },
    validate: (p) => {
      if (!p.name || typeof p.name !== "string" || !isKnownAppName(p.name)) return { valid: false, error: "name must be a known application." };
      return { valid: true };
    },
    execute: openApp,
  },
  {
    name: "closeApp",
    description:
      "Force-closes a known application by friendly name. MEDIUM risk: may lose unsaved work.",
    category: "applications",
    risk: "MEDIUM",
    timeoutMs: 15000,
    parameters: { type: "OBJECT", required: ["name"], properties: { name: APP_NAME_PROP } },
    validate: (p) => {
      if (!p.name || typeof p.name !== "string" || !isKnownAppName(p.name)) return { valid: false, error: "name must be a known application." };
      return { valid: true };
    },
    execute: closeApp,
  },
  {
    name: "focusApp",
    description: "Brings a known application's main window to the foreground.",
    category: "applications",
    risk: "LOW",
    timeoutMs: 15000,
    parameters: { type: "OBJECT", required: ["name"], properties: { name: APP_NAME_PROP } },
    validate: (p) => {
      if (!p.name || typeof p.name !== "string" || !isKnownAppName(p.name)) return { valid: false, error: "name must be a known application." };
      return { valid: true };
    },
    execute: focusApp,
  },
  {
    name: "createFile",
    description:
      "Creates a NEW text file. Fails if the file already exists. Path may be a bare filename " +
      "(resolved into the LOHZ workspace), a relative path like 'Desktop/notes.txt', " +
      "or an absolute path under Desktop/Documents/Downloads/workspace. Other paths are rejected.",
    category: "files",
    risk: "MEDIUM",
    timeoutMs: 10000,
    parameters: {
      type: "OBJECT",
      required: ["path"],
      properties: {
        path: stringProp("Target file path inside an allowed safe root."),
        content: stringProp(`Optional initial text content (max ${LIMITS.WRITE_MAX_BYTES} bytes).`),
      },
    },
    validate: (p) => {
      if (!pathTextValid(p.path)) return { valid: false, error: "path must be a safe non-empty string without traversal." };
      if (p.content !== undefined && typeof p.content !== "string") {
        return { valid: false, error: "content must be a string when provided." };
      }
      return { valid: true };
    },
    execute: createFile,
  },
  {
    name: "readFile",
    description: "Reads a small text file (max 200 KB) from an allowed safe root.",
    category: "files",
    risk: "MEDIUM",
    timeoutMs: 10000,
    parameters: { type: "OBJECT", required: ["path"], properties: { path: stringProp("File path inside an allowed safe root.") } },
    validate: (p) => {
      if (!pathTextValid(p.path)) return { valid: false, error: "path must be a safe non-empty string without traversal." };
      return { valid: true };
    },
    execute: readFile,
  },
  {
    name: "writeFile",
    description: "Writes (or overwrites) a text file inside an allowed safe root (max 1 MB).",
    category: "files",
    risk: "MEDIUM",
    timeoutMs: 10000,
    parameters: {
      type: "OBJECT",
      required: ["path", "content"],
      properties: {
        path: stringProp("Target file path inside an allowed safe root."),
        content: stringProp(`Text content (max ${LIMITS.WRITE_MAX_BYTES} bytes).`),
      },
    },
    validate: (p) => {
      if (!pathTextValid(p.path)) return { valid: false, error: "path must be a safe non-empty string without traversal." };
      if (typeof p.content !== "string") return { valid: false, error: "content (string) required." };
      if (Buffer.byteLength(p.content, "utf-8") > LIMITS.WRITE_MAX_BYTES) {
        return { valid: false, error: `content exceeds ${LIMITS.WRITE_MAX_BYTES} bytes.` };
      }
      return { valid: true };
    },
    execute: writeFile,
  },
  {
    name: "createFolder",
    description: "Creates a folder (recursively) inside an allowed safe root.",
    category: "files",
    risk: "MEDIUM",
    timeoutMs: 10000,
    parameters: { type: "OBJECT", required: ["path"], properties: { path: stringProp("Folder path inside an allowed safe root.") } },
    validate: (p) => {
      if (!pathTextValid(p.path)) return { valid: false, error: "path must be a safe non-empty string without traversal." };
      return { valid: true };
    },
    execute: createFolder,
  },
  {
    name: "renameFile",
    description: "Renames a file or folder to a new plain name (no separators) within the same directory.",
    category: "files",
    risk: "MEDIUM",
    timeoutMs: 10000,
    parameters: {
      type: "OBJECT",
      required: ["path", "newName"],
      properties: {
        path: stringProp("Current file/folder path inside an allowed safe root."),
        newName: stringProp("New plain filename (no separators, no ..)."),
      },
    },
    validate: (p) => {
      if (!pathTextValid(p.path)) return { valid: false, error: "path must be a safe non-empty string without traversal." };
      if (typeof p.newName !== "string" || !isSafeBasename(p.newName)) return { valid: false, error: "newName must be a safe plain name." };
      return { valid: true };
    },
    execute: renameFile,
  },
  {
    name: "openUrl",
    description: "Opens an http/https URL in the user's DEFAULT browser. Credentials and exotic protocols are rejected.",
    category: "browser",
    risk: "LOW",
    timeoutMs: 10000,
    parameters: {
      type: "OBJECT",
      required: ["url"],
      properties: { url: stringProp("An http:// or https:// URL pointing to a valid public hostname.") },
    },
    validate: (p) => {
      if (!p.url || typeof p.url !== "string") return { valid: false, error: "url (string) required." };
      try {
        const parsed = new URL(p.url);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
          return { valid: false, error: "url must be credential-free http(s)." };
        }
        if (!isPublicHostname(parsed.hostname)) return { valid: false, error: "url hostname must be public." };
      } catch { return { valid: false, error: "url must be valid http(s)." }; }
      return { valid: true };
    },
    execute: openUrl,
  },
  {
    name: "listWindows",
    description: "Lists all currently open visible windows (process name, title, window handle).",
    category: "windows",
    risk: "LOW",
    timeoutMs: 15000,
    parameters: { type: "OBJECT", properties: {}, required: [] },
    validate: () => ({ valid: true }),
    execute: async () => {
      const list = await listWindows();
      return { message: `Found ${list.length} window(s).`, data: { count: list.length, windows: list } };
    },
  },
  {
    name: "focusWindow",
    description:
      "Brings a window to the foreground by 'title' substring or by 'index' from listWindows.",
    category: "windows",
    risk: "LOW",
    timeoutMs: 15000,
    parameters: {
      type: "OBJECT",
      properties: {
        title: stringProp("Substring of the window title or process name."),
        index: { type: "INTEGER", description: "Index of the window from listWindows (0-based)." },
      },
      required: [],
    },
    validate: (p) => {
      if (p.title !== undefined && typeof p.title !== "string") return { valid: false, error: "title must be string." };
      if (p.index !== undefined && typeof p.index !== "number") return { valid: false, error: "index must be number." };
      return { valid: true };
    },
    execute: focusWindow,
  },
  {
    name: "minimizeWindow",
    description: "Minimizes a window identified by 'title' or 'index'.",
    category: "windows",
    risk: "LOW",
    timeoutMs: 12000,
    parameters: {
      type: "OBJECT",
      properties: {
        title: stringProp("Substring of the window title or process name."),
        index: { type: "INTEGER", description: "Index of the window from listWindows (0-based)." },
      },
      required: [],
    },
    validate: (p) => {
      if (p.title !== undefined && typeof p.title !== "string") return { valid: false, error: "title must be string." };
      if (p.index !== undefined && typeof p.index !== "number") return { valid: false, error: "index must be number." };
      return { valid: true };
    },
    execute: minimizeWindow,
  },
  {
    name: "maximizeWindow",
    description: "Maximizes (or restores) a window identified by 'title' or 'index' and brings it to the foreground.",
    category: "windows",
    risk: "LOW",
    timeoutMs: 12000,
    parameters: {
      type: "OBJECT",
      properties: {
        title: stringProp("Substring of the window title or process name."),
        index: { type: "INTEGER", description: "Index of the window from listWindows (0-based)." },
      },
      required: [],
    },
    validate: (p) => {
      if (p.title !== undefined && typeof p.title !== "string") return { valid: false, error: "title must be string." };
      if (p.index !== undefined && typeof p.index !== "number") return { valid: false, error: "index must be number." };
      return { valid: true };
    },
    execute: maximizeWindow,
  },
  {
    name: "takeScreenshot",
    description: "Captures the entire virtual screen and saves it to windows-agent/screenshots/. Returns the file path.",
    category: "screen",
    risk: "LOW",
    timeoutMs: 20000,
    parameters: { type: "OBJECT", properties: {}, required: [] },
    validate: () => ({ valid: true }),
    execute: takeScreenshot,
  },
  {
    name: "clipboardRead",
    description: "Reads current text content from the Windows clipboard (max 512 KB).",
    category: "clipboard",
    risk: "LOW",
    timeoutMs: 10000,
    parameters: { type: "OBJECT", properties: {}, required: [] },
    validate: () => ({ valid: true }),
    execute: clipboardRead,
  },
  {
    name: "clipboardWrite",
    description: "Writes text to the Windows clipboard, replacing existing content (max 512 KB).",
    category: "clipboard",
    risk: "MEDIUM",
    timeoutMs: 10000,
    parameters: {
      type: "OBJECT",
      required: ["content"],
      properties: { content: stringProp(`Text content to place on the clipboard (max ${LIMITS.CLIPBOARD_MAX_BYTES} bytes).`) },
    },
    validate: (p) => {
      if (typeof p.content !== "string") return { valid: false, error: "content (string) required." };
      if (Buffer.byteLength(p.content, "utf-8") > LIMITS.CLIPBOARD_MAX_BYTES) {
        return { valid: false, error: `content exceeds ${LIMITS.CLIPBOARD_MAX_BYTES} bytes.` };
      }
      return { valid: true };
    },
    execute: clipboardWrite,
  },
  {
    name: "getSystemInfo",
    description: "Returns basic system information (hostname, OS, CPU, memory).",
    category: "system",
    risk: "LOW",
    timeoutMs: 5000,
    parameters: { type: "OBJECT", properties: {}, required: [] },
    validate: () => ({ valid: true }),
    execute: getSystemInfo,
  },
  {
    name: "getVolume",
    description: "Reads the current master volume level (0..100) and mute state.",
    category: "system",
    risk: "LOW",
    timeoutMs: 15000,
    parameters: { type: "OBJECT", properties: {}, required: [] },
    validate: () => ({ valid: true }),
    execute: getVolume,
  },
  {
    name: "setVolume",
    description: "Sets master volume level (0..100) OR toggle mute. Provide exactly one of {level, mute}.",
    category: "system",
    risk: "LOW",
    timeoutMs: 15000,
    parameters: {
      type: "OBJECT",
      properties: {
        level: { type: "INTEGER", description: "Volume level 0..100." },
        mute: { type: "BOOLEAN", description: "True to mute, false to unmute." },
      },
      required: [],
    },
    validate: (p) => {
      if (p.level !== undefined && p.mute !== undefined) return { valid: false, error: "Provide only one of level or mute." };
      if (p.level === undefined && p.mute === undefined) return { valid: false, error: "Provide level or mute." };
      if (p.level !== undefined && (typeof p.level !== "number" || p.level < 0 || p.level > 100)) {
        return { valid: false, error: "level must be a number 0..100." };
      }
      if (p.mute !== undefined && typeof p.mute !== "boolean") {
        return { valid: false, error: "mute must be a boolean." };
      }
      return { valid: true };
    },
    execute: setVolume,
  },
];

const REGISTRY: Map<string, ToolDefinition> = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDefinition | undefined {
  return REGISTRY.get(name);
}

export function getAllTools(): ToolDefinition[] {
  return Array.from(REGISTRY.values());
}

export function getRisk(name: string): RiskLevel | null {
  const t = REGISTRY.get(name);
  return t ? t.risk : null;
}

/** Converts a registry entry into a Gemini-compatible function declaration. */
export function toGeminiDeclaration(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)) as ParamSchema,
  };
}

export function toAllGeminiDeclarations() {
  return TOOLS.map(toGeminiDeclaration);
}
