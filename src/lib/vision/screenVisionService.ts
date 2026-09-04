/**
 * Screen Vision Service for LOHZ Proactive Intelligence.
 *
 * Capabilities:
 * - Ambient diff detection to avoid redundant LLM calls when screen is static.
 * - Vision inspection with Gemini 2.0/Flash for terminal errors, stack traces, and active workspace questions.
 * - Structured actionable output with direct suggested remediations.
 */

import type { ModelGateway } from "../modelGateway/gateway";

export interface VisionInspectOptions {
  imageBase64: string; // PNG base64 data without data: prefix or with data: prefix
  mimeType?: string;
  mode?: "error_detect" | "screen_summary" | "qa";
  question?: string;
  userId?: string;
}

export interface VisionInspectResult {
  hasError: boolean;
  errorType?: "compiler" | "runtime" | "syntax" | "http" | "other";
  errorSnippet?: string;
  summary: string;
  suggestedAction?: string;
  rawText?: string;
}

/**
 * Computes a lightweight fast hash/fingerprint of a downsampled base64 thumbnail.
 * Samples every Nth character across the base64 payload to quickly detect significant visual shifts.
 */
export function computeImageSignature(base64: string, samplePoints = 64): string {
  const clean = base64.replace(/^data:image\/[a-z]+;base64,/, "");
  if (clean.length === 0) return "";
  const step = Math.max(1, Math.floor(clean.length / samplePoints));
  let sig = "";
  for (let i = 0; i < clean.length && sig.length < samplePoints; i += step) {
    sig += clean[i];
  }
  return sig;
}

/**
 * Compares two image signatures. Returns true if the visual difference exceeds threshold.
 * Threshold is normalized [0..1] where 0.12 represents ~12% character mismatch in signature.
 */
export function hasScreenChanged(prevSig: string, nextSig: string, threshold = 0.12): boolean {
  if (!prevSig || !nextSig) return true;
  if (prevSig === nextSig) return false;
  const len = Math.min(prevSig.length, nextSig.length);
  if (len === 0) return true;
  let diffs = Math.abs(prevSig.length - nextSig.length);
  for (let i = 0; i < len; i++) {
    if (prevSig[i] !== nextSig[i]) diffs++;
  }
  const ratio = diffs / Math.max(prevSig.length, nextSig.length);
  return ratio >= threshold;
}

const ERROR_DETECT_PROMPT = `You are LOHZ Vision Watchdog. Analyze this user desktop/workspace screenshot.
Determine if there is an active error, compilation failure, terminal stack trace, IDE red squiggly syntax error, or unhandled exception visible.

Respond ONLY with a JSON object matching this schema:
{
  "hasError": boolean,
  "errorType": "compiler" | "runtime" | "syntax" | "http" | "other" | null,
  "errorSnippet": "exact concise error text or exception message" | null,
  "summary": "Brief 1-sentence description of what is happening or the error found",
  "suggestedAction": "Exact immediate fix or command to run" | null
}`;

const SCREEN_SUMMARY_PROMPT = `You are LOHZ Assistant. Look at this user desktop screenshot and provide a concise, high-level summary of what the user is currently doing (active IDE file, open windows, terminal task, or browser topic).
Respond in 2 clear sentences.`;

export class ScreenVisionService {
  constructor(private readonly gateway: ModelGateway) {}

  async inspectScreen(options: VisionInspectOptions): Promise<VisionInspectResult> {
    const rawBase64 = options.imageBase64.replace(/^data:image\/[a-z]+;base64,/, "").trim();
    if (!rawBase64) {
      return {
        hasError: false,
        summary: "No image data provided.",
      };
    }

    const mimeType = options.mimeType || "image/png";
    const mode = options.mode || "error_detect";

    let prompt = ERROR_DETECT_PROMPT;
    let responseFormat: "json" | "text" = "json";

    if (mode === "screen_summary") {
      prompt = SCREEN_SUMMARY_PROMPT;
      responseFormat = "text";
    } else if (mode === "qa") {
      prompt = `The user is looking at this screen and asks: "${options.question || "Explain what is on the screen"}". Provide an accurate, helpful, and concise answer.`;
      responseFormat = "text";
    }

    const res = await this.gateway.generate({
      prompt,
      capability: "vision",
      responseFormat,
      userId: options.userId,
      reason: "screen_vision_inspection",
      images: [{ mimeType, data: rawBase64 }],
    });

    if (mode === "error_detect") {
      try {
        const parsed = JSON.parse(res.text.replace(/```json\s*|```/g, "").trim());
        return {
          hasError: Boolean(parsed.hasError),
          errorType: parsed.errorType || undefined,
          errorSnippet: parsed.errorSnippet || undefined,
          summary: parsed.summary || "Screen analyzed.",
          suggestedAction: parsed.suggestedAction || undefined,
          rawText: res.text,
        };
      } catch {
        // Fallback if model responded in markdown/text
        const hasErr = /error|failed|exception|syntaxerror|typeerror|not found/i.test(res.text);
        return {
          hasError: hasErr,
          summary: res.text.slice(0, 200),
          rawText: res.text,
        };
      }
    }

    return {
      hasError: false,
      summary: res.text,
      rawText: res.text,
    };
  }
}
