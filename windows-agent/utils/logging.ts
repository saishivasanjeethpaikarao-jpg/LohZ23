/**
 * Windows Agent structured logging.
 * Writes JSONL entries to windows-agent/logs/agent-YYYY-MM-DD.log and mirrors to console.
 * Sensitive material (tokens, raw file contents) is never logged verbatim.
 */
import fs from "fs";
import path from "path";
import { runtimeDataRoot } from "../../src/lib/runtimePaths";

const LOG_DIR = runtimeDataRoot("windows-agent", "logs");

// Log filenames are strictly generated: agent-YYYY-MM-DD.log. Anything else is rejected.
const SAFE_LOG_NAME = /^agent-\d{4}-\d{2}-\d{2}\.log$/;

if (!fs.existsSync(LOG_DIR)) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

/** Resolves a log file path and proves it stays inside LOG_DIR. Returns null if unsafe. */
function safeLogFilePath(fileName: string): string | null {
  if (!SAFE_LOG_NAME.test(fileName)) return null;
  const resolvedRoot = path.resolve(LOG_DIR);
  const resolvedTarget = path.resolve(LOG_DIR, fileName);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return resolvedTarget;
}

/** Keys whose values must be redacted in logs. */
const REDACT_KEYS = new Set(["content", "text", "token", "apikey", "password"]);

function sanitizeParams(params: Record<string, any> | undefined): Record<string, any> {
  if (!params) return {};
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(params)) {
    if (REDACT_KEYS.has(key.toLowerCase()) && typeof value === "string") {
      out[key] = `[redacted len=${value.length}]`;
    } else if (typeof value === "string" && value.length > 200) {
      out[key] = `${value.slice(0, 200)}...[truncated]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface ToolLogEntry {
  timestamp: string;
  kind: "EXECUTION";
  tool: string;
  params: Record<string, any>;
  risk: string;
  success: boolean;
  durationMs: number;
  errorCode: string | null;
  message: string;
}

export interface EventLogEntry {
  timestamp: string;
  kind: "EVENT";
  event: string;
  details?: string;
}

function appendLine(line: string): void {
  const fileName = `agent-${new Date().toISOString().slice(0, 10)}.log`;
  const filePath = safeLogFilePath(fileName);
  if (!filePath) {
    console.error("[Logger] Refusing unsafe log filename:", fileName);
    return;
  }
  try {
    fs.appendFileSync(filePath, line + "\n", "utf-8");
  } catch (err) {
    console.error("[Logger] Failed to write log file:", (err as Error).message);
  }
}

export function logExecution(entry: Omit<ToolLogEntry, "timestamp" | "kind">): void {
  const full: ToolLogEntry = { ...entry, timestamp: new Date().toISOString(), kind: "EXECUTION" };
  appendLine(JSON.stringify({ ...full, params: sanitizeParams(full.params) }));
  console.log(
    `[${full.timestamp}] EXEC ${full.tool}(${full.risk}) -> ${full.success ? "OK" : `FAIL(${full.errorCode})`} in ${full.durationMs}ms :: ${full.message}`
  );
}

export function logEvent(event: string, details?: string): void {
  const full: EventLogEntry = {
    timestamp: new Date().toISOString(),
    kind: "EVENT",
    event,
    details,
  };
  appendLine(JSON.stringify(full));
  console.log(`[${full.timestamp}] EVT  ${event}${details ? ` :: ${details}` : ""}`);
}
