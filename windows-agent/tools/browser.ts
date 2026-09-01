/**
 * Browser tool: openUrl — opens a validated URL in the user's DEFAULT browser.
 * Uses rundll32 FileProtocolHandler (no shell string, no command construction),
 * with strict URL validation: only http/https and a real hostname.
 */
import { spawn } from "child_process";
import { isPublicHostname } from "../utils/validation";

export async function openUrl(params: Record<string, any>) {
  const raw = String(params.url || "").trim();
  if (!raw) {
    const e = new Error("Parameter 'url' is required.");
    (e as any).code = "PARAM_MISSING";
    throw e;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    const e = new Error(`Invalid URL: "${raw}"`);
    (e as any).code = "URL_INVALID";
    throw e;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const e = new Error(`Only http/https URLs are allowed (got "${parsed.protocol}").`);
    (e as any).code = "URL_PROTOCOL_REJECTED";
    throw e;
  }
  if (!isPublicHostname(parsed.hostname)) {
    const e = new Error(`URL hostname "${parsed.hostname}" is not a valid public domain.`);
    (e as any).code = "URL_HOSTNAME_INVALID";
    throw e;
  }
  // Block credentials embedded in URL (scheme://user:pass@host).
  if (parsed.username || parsed.password) {
    const e = new Error("URLs with embedded credentials are rejected.");
    (e as any).code = "URL_CREDENTIALS_REJECTED";
    throw e;
  }

  const url = parsed.toString();
  try {
    const child = spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (err: any) {
    const e = new Error(`Could not open URL: ${err.message}`);
    (e as any).code = "URL_OPEN_FAILED";
    throw e;
  }
  return {
    message: `Opened ${url} in the default browser.`,
    data: { url },
  };
}
