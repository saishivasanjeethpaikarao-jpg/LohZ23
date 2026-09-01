import { describe, expect, it, vi } from "vitest";
import { AgentBridge } from "../agentBridge";
import { ExecutionReplayCache } from "../windows-agent/replayCache";

describe("Windows Agent replay and locality", () => {
  it("returns one shared result for concurrent/replayed request IDs", async () => {
    const cache = new ExecutionReplayCache<{ success: boolean }>();
    const execute = vi.fn(async () => ({ success: true }));
    const [a, b] = await Promise.all([
      cache.run("request-1", execute),
      cache.run("request-1", execute),
    ]);
    expect(a).toEqual({ success: true });
    expect(b).toEqual({ success: true });
    expect(execute).toHaveBeenCalledOnce();
    await cache.run("request-1", execute);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("refuses a non-loopback agent host", () => {
    expect(() => new AgentBridge({ host: "192.168.1.10", token: "x".repeat(40) })).toThrow("loopback");
  });
});
