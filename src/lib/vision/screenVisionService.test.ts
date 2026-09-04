import { describe, it, expect, vi } from "vitest";
import {
  computeImageSignature,
  hasScreenChanged,
  ScreenVisionService,
} from "./screenVisionService";
import type { ModelGateway } from "../modelGateway/gateway";

describe("ScreenVisionService", () => {
  describe("Signature & Diff Hashing", () => {
    it("computes signature for downscaled image base64", () => {
      const sampleB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const sig = computeImageSignature(sampleB64, 16);
      expect(sig.length).toBeGreaterThan(0);
      expect(sig.length).toBeLessThanOrEqual(16);
    });

    it("detects no change between identical frames", () => {
      const b64 = "abcdefghijklmnopqrstuvwxyz0123456789";
      const sig1 = computeImageSignature(b64);
      const sig2 = computeImageSignature(b64);
      expect(hasScreenChanged(sig1, sig2)).toBe(false);
    });

    it("detects change when frames differ significantly", () => {
      const b64A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const b64B = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
      const sigA = computeImageSignature(b64A);
      const sigB = computeImageSignature(b64B);
      expect(hasScreenChanged(sigA, sigB)).toBe(true);
    });
  });

  describe("Screen Inspection Logic", () => {
    it("handles error_detect mode with valid JSON response", async () => {
      const mockGateway = {
        generate: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            hasError: true,
            errorType: "compiler",
            errorSnippet: "TS2304: Cannot find name 'foo'",
            summary: "TypeScript compilation error found in terminal",
            suggestedAction: "Declare 'foo' or import it from ./foo",
          }),
          provider: "gemini",
          model: "gemini-2.5-flash",
          capability: "vision",
          latencyMs: 150,
        }),
      } as unknown as ModelGateway;

      const service = new ScreenVisionService(mockGateway);
      const result = await service.inspectScreen({
        imageBase64: "dGVzdGltYWdl",
        mode: "error_detect",
        userId: "user-123",
      });

      expect(result.hasError).toBe(true);
      expect(result.errorType).toBe("compiler");
      expect(result.errorSnippet).toContain("TS2304");
      expect(result.suggestedAction).toContain("Declare 'foo'");
      expect(mockGateway.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "vision",
          userId: "user-123",
        })
      );
    });

    it("handles screen_summary mode", async () => {
      const mockGateway = {
        generate: vi.fn().mockResolvedValue({
          text: "User is editing React components in VS Code with a terminal open.",
          provider: "gemini",
          model: "gemini-2.5-flash",
          capability: "vision",
          latencyMs: 120,
        }),
      } as unknown as ModelGateway;

      const service = new ScreenVisionService(mockGateway);
      const result = await service.inspectScreen({
        imageBase64: "dGVzdGltYWdl",
        mode: "screen_summary",
      });

      expect(result.hasError).toBe(false);
      expect(result.summary).toContain("User is editing React components");
    });
  });
});
