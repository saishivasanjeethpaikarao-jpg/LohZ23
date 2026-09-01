/**
 * Execution guards backed by the Windows Agent registry. The registry is the
 * sole schema and risk authority; this module only adapts its contract to the
 * planner/executor vocabulary and adds the hard destructive denylist.
 */
import { getRisk, getTool } from "../../../windows-agent/toolRegistry";
import { DESTRUCTIVE_TOOLS } from "./types";

const SIDE_EFFECTING_TOOLS = new Set([
  "openApp", "closeApp", "setVolume", "clipboardWrite", "createFile",
  "writeFile", "createFolder", "renameFile", "openUrl",
]);

export function isDestructive(toolName: string): boolean {
  return DESTRUCTIVE_TOOLS.has(toolName);
}

export function isSideEffecting(toolName: string): boolean {
  return SIDE_EFFECTING_TOOLS.has(toolName);
}

export interface ArgCheck {
  ok: boolean;
  reason?: string;
}

export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown> | undefined
): ArgCheck {
  const tool = getTool(toolName);
  if (!tool) return { ok: false, reason: `no registered tool '${toolName}'` };
  const input = args ?? {};
  const properties = tool.parameters.properties ?? {};

  for (const key of Object.keys(input)) {
    if (!(key in properties)) return { ok: false, reason: `unknown argument '${key}' for ${toolName}` };
  }
  for (const key of tool.parameters.required ?? []) {
    if (input[key] === undefined) return { ok: false, reason: `${key} is required for ${toolName}` };
  }

  const result = tool.validate(input);
  return result.valid ? { ok: true } : { ok: false, reason: result.error ?? "registry validation failed" };
}

export function toolRisk(toolName: string): "safe" | "low" | "medium" | "high" | "critical" {
  if (isDestructive(toolName)) return "critical";
  const risk = getRisk(toolName);
  if (risk === "LOW") return "low";
  if (risk === "MEDIUM") return "medium";
  if (risk === "HIGH") return "high";
  return "high";
}
