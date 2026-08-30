/**
 * Safe PowerShell runner for the Windows Agent.
 *
 * Security model:
 * - Only FIXED script templates run here; scripts are assembled in the tool modules.
 * - Any user-supplied dynamic value (text, paths) is embedded as a base64 literal
 *   and decoded inside PowerShell, so no quoting/injection surface exists.
 * - Every invocation has a hard timeout and the child process is killed on breach.
 */
import { spawn } from "child_process";

export interface PowerShellResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Encodes a UTF-8 string into a PS-safe single-quoted base64 literal. */
export function psB64(value: string): string {
  const b64 = Buffer.from(value, "utf-8").toString("base64");
  // base64 charset is [A-Za-z0-9+/=]; single quotes make it a literal in PS.
  return `'${b64}'`;
}

/** PS snippet that decodes a psB64 literal into $val. */
export function psDecodeInto(varName: string, literal: string): string {
  return `$${varName} = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(${literal}))`;
}

const OUTPUT_ENCODING_PREFIX =
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}";

export function runPowerShell(script: string, timeoutMs = 20000): Promise<PowerShellResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `${OUTPUT_ENCODING_PREFIX}; ${script}`],
      { windowsHide: true }
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      if (stdout.length > 4 * 1024 * 1024) {
        try {
          child.kill();
        } catch {}
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
      if (stderr.length > 512 * 1024) {
        try {
          child.kill();
        } catch {}
      }
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: !timedOut && exitCode === 0 && stderr.trim().length === 0,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      stderr += String(err);
      finish(null);
    });
  });
}

/** Runs a PowerShell script that must emit a machine-readable line "OK[|payload]"; anything else is failure. */
export interface MarkerResult {
  ok: boolean;
  payload: string;
  stderr: string;
  timedOut: boolean;
}

export async function runPowerShellMarker(script: string, timeoutMs = 20000): Promise<MarkerResult> {
  const result = await runPowerShell(script, timeoutMs);
  if (result.timedOut) {
    return { ok: false, payload: "", stderr: "PowerShell timed out.", timedOut: true };
  }
  if (!result.ok) {
    return { ok: false, payload: "", stderr: result.stderr || `exit ${result.exitCode}`, timedOut: false };
  }
  const lines = result.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const markerLine = lines.find((l) => l.startsWith("OK"));
  if (!markerLine) {
    return { ok: false, payload: "", stderr: result.stdout.slice(0, 500), timedOut: false };
  }
  return {
    ok: true,
    payload: markerLine.length > 3 ? markerLine.slice(3) : "",
    stderr: "",
    timedOut: false,
  };
}
