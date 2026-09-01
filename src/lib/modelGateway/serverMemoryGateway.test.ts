import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { processConversationSlice } from "../../../server_memory";
import type { ModelGateway } from "./gateway";
import { CostLimitExceededError } from "./types";
import type { Memory } from "../memoryTypes";
import type { MemoryStore } from "../persistence/memoryStore";
import { LocalFileMemoryStore } from "../persistence/localFileMemoryStore";
import os from "os";

const TEST_USER = "gateway_slice_test_user";
const MEMORY_FILE = path.join(process.cwd(), "data", "memories", `${TEST_USER}.json`);

function makeMockGateway(
  impl: (req: { prompt: string; capability: string; userId?: string; reason?: string }) => Promise<{ text: string }>
): ModelGateway {
  return {
    generate: vi.fn(impl) as unknown as ModelGateway["generate"],
  } as unknown as ModelGateway;
}

function memoryStore(initial: Memory[] = [], saveResult = true): MemoryStore & { data: Memory[]; saves: number } {
  return {
    data: [...initial],
    saves: 0,
    async load() { return [...this.data]; },
    async save(_uid, memories) { this.saves++; if (saveResult) this.data = [...memories]; return saveResult; },
    async add(_uid, memory) { this.data.push(memory); return true; },
    async delete(_uid, id) { this.data = this.data.filter((m) => m.id !== id); return true; },
    async isHealthy() { return true; },
    backendName() { return "test"; },
  };
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

  it("rejects malformed or stale model transactions without writing", async () => {
    const store = memoryStore();
    const mock = makeMockGateway(async () => ({
      text: JSON.stringify({
        transactions: [{ action: "UPDATE", id: "invented", category: "goal", text: "Forged update" }],
      }),
    }));

    expect(await processConversationSlice("unused", DIALOGUE, "stale-model-user", mock, store)).toBeNull();
    expect(store.saves).toBe(0);
    expect(store.data).toEqual([]);
  });

  it("does not report an updated memory list when persistence fails", async () => {
    const store = memoryStore([], false);
    const mock = makeMockGateway(async () => ({
      text: JSON.stringify({ transactions: [{ action: "ADD", category: "goal", text: "The user studies astrophysics." }] }),
    }));

    expect(await processConversationSlice("unused", DIALOGUE, "failing-store-user", mock, store)).toBeNull();
    expect(store.saves).toBe(1);
  });

  it("serializes concurrent slices for one user so neither update is lost", async () => {
    const store = memoryStore();
    let call = 0;
    const mock = makeMockGateway(async () => ({
      text: JSON.stringify({
        transactions: [{ action: "ADD", category: "preference", text: `Durable preference ${++call}` }],
      }),
    }));
    const firstDialogue = [
      { role: "user", text: "I prefer concise technical explanations." },
      { role: "model", text: "Understood." },
    ];
    const secondDialogue = [
      { role: "user", text: "I prefer dark themes in every application." },
      { role: "model", text: "Understood." },
    ];

    await Promise.all([
      processConversationSlice("unused", firstDialogue, "queued-user", mock, store),
      processConversationSlice("unused", secondDialogue, "queued-user", mock, store),
    ]);

    expect(store.data.map((m) => m.text)).toEqual(["Durable preference 1", "Durable preference 2"]);
  });

  it("refuses add/delete when a local memory file is corrupt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lohz-memory-corrupt-"));
    try {
      await fs.writeFile(path.join(dir, "corrupt-user.json"), "not-json", "utf-8");
      const store = new LocalFileMemoryStore(dir);
      const sample = {
        id: "m1", layer: "semantic", category: "goal", text: "sample",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        metadata: { importance: 0.5, confidence: 0.8, source: "conversation", timestamp: Date.now(), lastAccessed: Date.now(), lastReinforced: Date.now(), category: "goal", relationships: [], userId: "corrupt-user" },
      } as Memory;
      expect(await store.add("corrupt-user", sample)).toBe(false);
      expect(await store.delete("corrupt-user", "m1")).toBe(false);
      expect(await fs.readFile(path.join(dir, "corrupt-user.json"), "utf-8")).toBe("not-json");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent local adds without losing either record", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lohz-memory-adds-"));
    try {
      const store = new LocalFileMemoryStore(dir);
      const makeMemory = (id: string): Memory => ({
        id, layer: "semantic", category: "goal", text: id,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        metadata: { importance: 0.5, confidence: 0.8, source: "conversation", timestamp: Date.now(), lastAccessed: Date.now(), lastReinforced: Date.now(), category: "goal", relationships: [], userId: "parallel-user" },
      });
      await Promise.all([store.add("parallel-user", makeMemory("m1")), store.add("parallel-user", makeMemory("m2"))]);
      expect((await store.load("parallel-user"))?.map((memory) => memory.id).sort()).toEqual(["m1", "m2"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
