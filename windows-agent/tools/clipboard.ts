/**
 * Clipboard tools: clipboardRead / clipboardWrite.
 * Text travels base64-encoded into a FIXED PowerShell script (no interpolation).
 */
import { LIMITS } from "../utils/validation";
import { psDecodeInto, runPowerShell, runPowerShellMarker } from "../utils/powershell";

export async function clipboardRead(): Promise<{ message: string; data: Record<string, any> }> {
  const result = await runPowerShell("Get-Clipboard -Raw -ErrorAction SilentlyContinue", 10000);
  if (result.timedOut || result.exitCode !== 0) {
    const e = new Error(`clipboardRead failed: ${result.stderr || "timeout"}`);
    (e as any).code = "CLIPBOARD_READ_FAILED";
    throw e;
  }
  const content = result.stdout; // already trimmed by runner; empty clipboard -> ""
  if (Buffer.byteLength(content, "utf-8") > LIMITS.CLIPBOARD_MAX_BYTES) {
    const e = new Error("Clipboard content exceeds the size limit.");
    (e as any).code = "CLIPBOARD_TOO_LARGE";
    throw e;
  }
  return {
    message: content ? `Clipboard contains ${content.length} characters.` : "Clipboard is empty.",
    data: { content },
  };
}

export async function clipboardWrite(params: Record<string, any>) {
  if (typeof params.content !== "string") {
    const e = new Error("Parameter 'content' (string) is required.");
    (e as any).code = "PARAM_MISSING";
    throw e;
  }
  if (Buffer.byteLength(params.content, "utf-8") > LIMITS.CLIPBOARD_MAX_BYTES) {
    const e = new Error(`Content exceeds ${LIMITS.CLIPBOARD_MAX_BYTES} byte limit.`);
    (e as any).code = "CONTENT_TOO_LARGE";
    throw e;
  }
  const b64 = Buffer.from(params.content, "utf-8").toString("base64");
  const script = `
${psDecodeInto("text", `'${b64}'`)}
Set-Clipboard -Value $text
Write-Output "OK|done"
`.trim();
  const result = await runPowerShellMarker(script, 10000);
  if (!result.ok) {
    const e = new Error(`clipboardWrite failed: ${result.stderr}`);
    (e as any).code = "CLIPBOARD_WRITE_FAILED";
    throw e;
  }
  return {
    message: `Wrote ${params.content.length} characters to the clipboard.`,
    data: { length: params.content.length },
  };
}
