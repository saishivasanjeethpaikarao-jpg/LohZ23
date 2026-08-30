/**
 * Phase 30 - closed verification rule registry (Section 5).
 * One source of truth, keyed by the EXISTING tool names. No second
 * registry: this maps verification semantics onto tools the registry
 * already defines. Unknown tool -> NONE -> INCONCLUSIVE (never success).
 */
import type { PlanStep } from "../planner/types";
import type { VerificationLevel, VerificationVerdict } from "./types";

export interface VerifyInputs {
  step: PlanStep;
  /** Raw tool outcome from execution (ok = runner-level success). */
  toolOk: boolean;
  toolResultRaw: unknown;
  /** Probe result when a probeTool ran; null if unavailable/failed. */
  probeOk: boolean | null;
  probeResultRaw: unknown;
}

export interface VerifyOutcome {
  verdict: VerificationVerdict;
  level: VerificationLevel;
  observedState: string;
  evidence: string;
  confidence: number;
}

export interface VerifyRule {
  level: VerificationLevel;
  /** Read-only tool used for STATE_CHECK / MULTI_SIGNAL probes. */
  probeTool?: string;
  /** TOOL_RESULT is sufficient only where explicitly declared. */
  toolResultSufficient?: boolean;
  evaluate: (i: VerifyInputs) => Omit<VerifyOutcome, "level">;
}

function ok(verdict: VerificationVerdict, observedState: string, evidence: string, confidence: number): Omit<VerifyOutcome, "level"> {
  return { verdict, observedState, evidence, confidence };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const VERIFICATION_RULES: Record<string, VerifyRule> = {
  openApp: {
    level: "STATE_CHECK",
    probeTool: "listWindows",
    evaluate: (i) => {
      const titles = JSON.stringify(i.probeResultRaw ?? "").toLowerCase();
      const name = String(i.step.arguments?.name ?? "").toLowerCase();
      const open = Boolean(name) && titles.includes(name);
      // Probe evidence is authoritative when available:
      if (i.probeOk !== null && i.probeOk !== undefined) {
        if (open) return ok("VERIFIED", `${name} window present`, "window list contains target", 0.9);
        return ok("FAILED", `${name} not found in windows`, "probe contradicts/omits target", 0.85);
      }
      if (!i.toolOk) return ok("FAILED", "launch failed", "tool error, no probe", 0.7);
      return ok("INCONCLUSIVE", "window state unknown", "probe unavailable", 0.3);
    },
  },
  closeApp: {
    level: "STATE_CHECK",
    probeTool: "listWindows",
    evaluate: (i) => {
      const titles = JSON.stringify(i.probeResultRaw ?? "").toLowerCase();
      const name = String(i.step.arguments?.name ?? "").toLowerCase();
      if (i.probeOk !== null && !titles.includes(name)) return ok("VERIFIED", `${name} closed`, "window no longer listed", 0.9);
      if (titles.includes(name)) return ok("FAILED", `${name} still running`, "window still present", 0.85);
      return ok("INCONCLUSIVE", "close state unknown", "no probe evidence", 0.3);
    },
  },
  setVolume: {
    level: "STATE_CHECK",
    probeTool: "getVolume",
    evaluate: (i) => {
      if (!i.probeOk) return i.toolOk
        ? ok("INCONCLUSIVE", "volume readback unavailable", "probe failed after set", 0.3)
        : ok("FAILED", "set failed and readback unavailable", "both signals negative", 0.6);
      const vol = (i.probeResultRaw as { levelPercent?: number; volume?: number; level?: number } | undefined);
      const actual = typeof vol === "object" ? (vol.levelPercent ?? vol.volume ?? vol.level) : (vol as unknown as number);
      const expected = i.step.arguments?.level;
      if (actual === expected) return ok("VERIFIED", `volume == ${expected}`, "readback matches", 0.95);
      // Already at desired level counts as verified without re-mutation.
      if (typeof actual === "number" && actual === expected) return ok("VERIFIED", "already at level", "readback equal", 0.9);
      return ok("FAILED", `volume ${actual} != ${expected}`, "readback mismatch", 0.8);
    },
  },
  clipboardWrite: {
    level: "MULTI_SIGNAL",
    probeTool: "clipboardRead",
    evaluate: (i) => {
      if (!i.probeOk) return ok("INCONCLUSIVE", "clipboard readback unavailable", "probe failed", 0.3);
      const read = str(i.probeResultRaw);
      const expected = str(i.step.arguments?.content);
      if (expected.length > 0 && read.includes(expected.slice(0, Math.min(80, expected.length)))) {
        return ok("VERIFIED", "clipboard contains payload", "readback match", 0.9);
      }
      return ok("FAILED", "clipboard content mismatch", "readback differs", 0.8);
    },
  },
  createFile: {
    level: "STATE_CHECK",
    probeTool: "readFile",
    evaluate: (i) => {
      const p = str(i.step.arguments?.path);
      if (i.probeOk) return ok("VERIFIED", `${p} exists`, "readback succeeded", 0.9);
      return i.toolOk
        ? ok("INCONCLUSIVE", `${p} existence unknown`, "probe could not confirm", 0.3)
        : ok("FAILED", `${p} not created`, "create reported failure", 0.7);
    },
  },
  writeFile: {
    level: "STATE_CHECK",
    probeTool: "readFile",
    evaluate: (i) => {
      const p = str(i.step.arguments?.path);
      if (i.probeOk) return ok("VERIFIED", `${p} readable`, "file present after write", 0.9);
      return i.toolOk
        ? ok("INCONCLUSIVE", `${p} write unconfirmed`, "probe failed", 0.3)
        : ok("FAILED", `${p} write failed`, "write error", 0.7);
    },
  },
  createFolder: {
    level: "TOOL_RESULT",
    toolResultSufficient: true,
    evaluate: (i) => i.toolOk
      ? ok("VERIFIED", "folder created", "registry-validated local op", 0.8)
      : ok("FAILED", "folder create failed", "tool error", 0.7),
  },
  renameFile: {
    level: "MULTI_SIGNAL",
    probeTool: "readFile",
    evaluate: (i) => {
      // probe runs against NEW path; old-path absence is inferred by a
      // second probe executed via args.from when provided.
      const newOk = i.probeOk;
      if (newOk) return ok("VERIFIED", "new path present", "rename confirmed", 0.85);
      return i.toolOk
        ? ok("INCONCLUSIVE", "rename unconfirmed", "new path unreadable", 0.3)
        : ok("FAILED", "rename failed", "tool error", 0.7);
    },
  },
  readFile: {
    level: "TOOL_RESULT",
    toolResultSufficient: true,
    evaluate: (i) => i.toolOk
      ? ok("VERIFIED", "file read", "content returned", 0.85)
      : ok("FAILED", "read failed", "tool error", 0.7),
  },
  openUrl: {
    level: "NONE",
    evaluate: (i) => i.toolOk
      ? ok("INCONCLUSIVE", "navigation not independently verifiable", "browser state not exposed", 0.35)
      : ok("FAILED", "open failed", "tool error", 0.7),
  },
  takeScreenshot: {
    level: "TOOL_RESULT",
    toolResultSufficient: true,
    evaluate: (i) => i.toolOk
      ? ok("VERIFIED", "screenshot captured", "agent returned image data", 0.8)
      : ok("FAILED", "screenshot failed", "tool error", 0.7),
  },
  getVolume: { level: "TOOL_RESULT", toolResultSufficient: true, evaluate: (i) => i.toolOk ? ok("VERIFIED", "volume read", "result returned", 0.85) : ok("FAILED", "read failed", "tool error", 0.7) },
  getSystemInfo: { level: "TOOL_RESULT", toolResultSufficient: true, evaluate: (i) => i.toolOk ? ok("VERIFIED", "system info read", "result returned", 0.85) : ok("FAILED", "read failed", "tool error", 0.7) },
  clipboardRead: { level: "TOOL_RESULT", toolResultSufficient: true, evaluate: (i) => i.toolOk ? ok("VERIFIED", "clipboard read", "result returned", 0.85) : ok("FAILED", "read failed", "tool error", 0.7) },
};

export function ruleFor(toolName: string | null | undefined): VerifyRule | null {
  if (!toolName) return null;
  return VERIFICATION_RULES[toolName] ?? null;
}
