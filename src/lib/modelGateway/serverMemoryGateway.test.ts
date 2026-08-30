import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { processConversationSlice } from "../../../server_memory";
import type { ModelGateway } from "./gateway";
import { CostLimitExceededError } from "./types";

const TEST_USER = "gateway_slice_test_user";
const MEMORY_FILE = path.join(process.cwd(), "data", "memories", `${TEST_USER}.json`);

function makeMockGateway(
  impl: (req: { prompt: string; capability: string; userId?: string; reason?: string }) => Promise<{ text: string }>
): ModelGateway {
  return {
    generate: vi.fn(impl) as unknown as ModelGateway["generate"],
  } as unknown as ModelGateway;
}

const DIALOGUE = [
  { role: "user", text: "I really enjoy studying astrophysics more than history." },
  { role: "model", text: "Understood — I will remember that." },
];

describe("Memory extraction via ModelGateway", () => {
  afterEach(async () => {
    if (existsSync(MEMORY_FILE)) {
      await fs.rm(MEMORY_FILE);
    }
  });

  it("routes generation through the gateway with attribution and applies transactions", async () => {
    const mock = makeMockGateway(async () => ({
      text: JSON.stringify({
        transactions: [{ action: "ADD", category: "goal", text: "The user studies astrophysics." }],
      }),
    }));

    const result = await processConversationSlice("unused-key", DIALOGUE, TEST_USER, mock);

    expect(mock.generate).toHaveBeenCalledTimes(1);
    const call = (mock.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.capability).toBe("memory_consolidation");
    expect(call.userId).toBe(TEST_USER);
    expect(call.reason).toBe("memory_extraction");

    expect(result).not.toBeNull();
    const added = result!.find((m) => m.text.includes("astrophysics"));
    expect(added).toBeDefined();
    expect(added!.metadata.userId).toBe(TEST_USER);
  });

  it("fails safely when the gateway rejects on cost limit", async () => {
    const before = existsSync(MEMORY_FILE) ? await fs.readFile(MEMORY_FILE, "utf-8") : null;

    const mock = makeMockGateway(async () => {
      throw new CostLimitExceededError(500_000, 200_000);
    });

    const result = await processConversationSlice("unused-key", DIALOGUE, TEST_USER, mock);

    expect(result).toBeNull();

    // No partial memory writes may occur when budget enforcement trips.
    const after = existsSync(MEMORY_FILE) ? await fs.readFile(MEMORY_FILE, "utf-8") : null;
    expect(after).toBe(before);
  });
});
