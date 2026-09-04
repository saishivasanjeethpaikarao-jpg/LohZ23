import { describe, it, expect, vi } from "vitest";
import { classifyClipboardContent } from "./clipboardSentinel";

describe("ClipboardSentinel classifier", () => {
  const mkCallbacks = () => ({
    onDebugError: vi.fn(),
    onOpenUrl: vi.fn(),
    onSetAtmosphere: vi.fn(),
    onExecuteCommand: vi.fn(),
  });

  it("detects GitHub repositories and wires actions", () => {
    const cb = mkCallbacks();
    const chip = classifyClipboardContent("https://github.com/facebook/react.git", cb);
    expect(chip).not.toBeNull();
    expect(chip?.type).toBe("git_repo");
    expect(chip?.title).toContain("react");
    chip?.execute();
    expect(cb.onExecuteCommand).toHaveBeenCalledWith("open vs code");
    expect(cb.onOpenUrl).toHaveBeenCalledWith("https://github.com/facebook/react.git");
  });

  it("detects YouTube URLs", () => {
    const cb = mkCallbacks();
    const chip = classifyClipboardContent("https://www.youtube.com/watch?v=dQw4w9WgXcQ", cb);
    expect(chip).not.toBeNull();
    expect(chip?.type).toBe("youtube_url");
    chip?.execute();
    expect(cb.onOpenUrl).toHaveBeenCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("detects runtime errors and stack traces", () => {
    const cb = mkCallbacks();
    const errorText = "TypeError: Cannot read properties of undefined (reading 'map')\n    at App.render (App.tsx:42:15)";
    const chip = classifyClipboardContent(errorText, cb);
    expect(chip).not.toBeNull();
    expect(chip?.type).toBe("error_stack");
    chip?.execute();
    expect(cb.onDebugError).toHaveBeenCalledWith(errorText);
  });

  it("detects hex color codes", () => {
    const cb = mkCallbacks();
    const chip = classifyClipboardContent("#10b981", cb);
    expect(chip).not.toBeNull();
    expect(chip?.type).toBe("hex_color");
    chip?.execute();
    expect(cb.onSetAtmosphere).toHaveBeenCalledWith("#10b981");
  });

  it("detects JSON objects and arrays", () => {
    const cb = mkCallbacks();
    const jsonStr = '{"model": "gemini-2.5", "tokens": 4200, "status": "active"}';
    const chip = classifyClipboardContent(jsonStr, cb);
    expect(chip).not.toBeNull();
    expect(chip?.type).toBe("json_data");
    chip?.execute();
    expect(cb.onExecuteCommand).toHaveBeenCalled();
  });

  it("returns null for normal conversational text", () => {
    const cb = mkCallbacks();
    expect(classifyClipboardContent("hello there world", cb)).toBeNull();
    expect(classifyClipboardContent("good morning!", cb)).toBeNull();
  });
});
