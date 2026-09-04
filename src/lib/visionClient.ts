/**
 * Client-side Vision Sentinel Controller.
 * Captures screen frames (via Electron native desktopCapturer or server screenshot),
 * tracks perceptual diffs, and requests proactive error detection from Gemini 2.0 Flash.
 */

import { computeImageSignature, hasScreenChanged, type VisionInspectResult } from "./vision/screenVisionService";

export interface VisionCaptureResult {
  ok: boolean;
  dataUrl?: string;
  error?: string;
}

export async function captureCurrentScreen(maxWidth = 1280): Promise<VisionCaptureResult> {
  const desktop = (window as any).lohzDesktop;
  if (desktop && typeof desktop.captureScreen === "function") {
    try {
      const res = await desktop.captureScreen({ maxWidth });
      if (res.ok && res.dataUrl) {
        return { ok: true, dataUrl: res.dataUrl };
      }
    } catch (e: any) {
      console.warn("[VisionClient] Native screen capture failed:", e);
    }
  }

  // Fallback to server-side capture via empty payload
  return { ok: true, dataUrl: "" };
}

export async function inspectScreenWithLohz(options: {
  imageBase64?: string;
  mode?: "error_detect" | "screen_summary" | "qa";
  question?: string;
  token?: string;
}): Promise<VisionInspectResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const response = await fetch("/api/vision/inspect", {
    method: "POST",
    headers,
    body: JSON.stringify({
      imageBase64: options.imageBase64,
      mode: options.mode || "error_detect",
      question: options.question,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || `Vision inspection failed (${response.status})`);
  }

  return response.json();
}

export class VisionWatchdog {
  private lastSignature: string = "";
  private intervalId: any = null;
  private isAnalyzing = false;
  private onAlertCallback?: (result: VisionInspectResult) => void;

  start(onAlert: (result: VisionInspectResult) => void, intervalMs = 25000, token?: string) {
    this.stop();
    this.onAlertCallback = onAlert;

    const tick = async () => {
      if (this.isAnalyzing) return;
      try {
        const capture = await captureCurrentScreen(640); // low-res thumbnail for diffing
        if (!capture.ok || !capture.dataUrl) return;

        const currentSig = computeImageSignature(capture.dataUrl);
        const changed = hasScreenChanged(this.lastSignature, currentSig, 0.15);
        this.lastSignature = currentSig;

        if (!changed) return; // Screen hasn't changed; avoid LLM call

        this.isAnalyzing = true;
        const result = await inspectScreenWithLohz({
          imageBase64: capture.dataUrl,
          mode: "error_detect",
          token,
        });

        if (result.hasError && this.onAlertCallback) {
          this.onAlertCallback(result);
        }
      } catch (err) {
        console.warn("[VisionWatchdog] Ambient check skipped:", err);
      } finally {
        this.isAnalyzing = false;
      }
    };

    this.intervalId = setInterval(tick, intervalMs);
    // Trigger initial after 5s
    setTimeout(tick, 5000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isAnalyzing = false;
  }
}
