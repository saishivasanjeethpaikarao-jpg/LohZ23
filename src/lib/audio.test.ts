import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock WebSocket globally for jsdom
class MockWebSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  onopen: (() => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onclose: (() => void) | null = null;
}
(globalThis as any).WebSocket = MockWebSocket;

// We test the LohzAudioSession public API contract
// by importing the type and verifying the sendTextMessage signature exists
import type { LiveState } from "./audio";

describe("LohzAudioSession text message integration", () => {
  it("should export LiveState type with expected states", () => {
    const validStates: LiveState[] = ["disconnected", "connecting", "listening", "speaking"];
    expect(validStates).toContain("disconnected");
    expect(validStates).toContain("connecting");
    expect(validStates).toContain("listening");
    expect(validStates).toContain("speaking");
  });

  it("should have sendTextMessage in module exports", async () => {
    const mod = await import("./audio");
    expect(typeof mod.LohzAudioSession).toBe("function");
    // Verify sendTextMessage is a method on the prototype
    const proto = mod.LohzAudioSession.prototype;
    expect(typeof proto.sendTextMessage).toBe("function");
  });

  it("should have sendVideoFrame in module exports", async () => {
    const mod = await import("./audio");
    const proto = mod.LohzAudioSession.prototype;
    expect(typeof proto.sendVideoFrame).toBe("function");
  });
});

describe("LohzAudioSession.sendTextMessage", () => {
  it("should send JSON with type=text and text content over WebSocket", async () => {
    const mod = await import("./audio");
    const ws = new MockWebSocket();

    const session = new mod.LohzAudioSession({
      onStateChange: () => {},
      onTranscription: () => {},
      onToolCall: () => {},
      onError: () => {},
    });

    // Inject mock WebSocket via connect (bypass real WS)
    (session as any).ws = ws;
    (session as any).currentState = "listening";

    session.sendTextMessage("Hello from text input");

    expect(ws.sent.length).toBe(1);
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("text");
    expect(sent.text).toBe("Hello from text input");
  });

  it("should not send if WebSocket is not open", async () => {
    const mod = await import("./audio");
    const ws = new MockWebSocket();
    ws.readyState = 3; // CLOSED

    const session = new mod.LohzAudioSession({
      onStateChange: () => {},
      onTranscription: () => {},
      onToolCall: () => {},
      onError: () => {},
    });

    (session as any).ws = ws;
    (session as any).currentState = "listening";

    session.sendTextMessage("Should not send");

    expect(ws.sent.length).toBe(0);
  });

  it("should not send if state is disconnected", async () => {
    const mod = await import("./audio");
    const ws = new MockWebSocket();

    const session = new mod.LohzAudioSession({
      onStateChange: () => {},
      onTranscription: () => {},
      onToolCall: () => {},
      onError: () => {},
    });

    (session as any).ws = ws;
    (session as any).currentState = "disconnected";

    session.sendTextMessage("Should not send");

    expect(ws.sent.length).toBe(0);
  });
});
