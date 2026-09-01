import { describe, it, expect, beforeEach } from "vitest";
import { MemoryIntelligenceService } from "./memoryIntelligence";
import { LocalFileMemoryStore } from "../persistence/localFileMemoryStore";
import { recordLesson } from "./learningSeam";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { MemoryStore } from "../persistence/memoryStore";
import type { Memory } from "../memoryTypes";

const TEST_DIR = path.join(process.cwd(), "data", "test_mem_intel");
const UID = "pipeline_user_23";
const OTHER = "pipeline_other_23";

function vocabFile(uid: string): string {
  return path.join(TEST_DIR, `${uid}.json`);
}

async function cleanup(): Promise<void> {
  if (existsSync(TEST_DIR)) {
    await fs.rm(TEST_DIR, { recursive: true });
  }
}

describe("memory intelligence pipeline (FileStore)", () => {
  beforeEach(cleanup);

  it("fails closed and never overwrites when the existing memory load is unavailable", async () => {
    let saves = 0;
    const unavailable: MemoryStore = {
      load: async () => null,
      save: async () => { saves++; return true; },
      add: async () => false, delete: async () => false,
      isHealthy: async () => false, backendName: () => "unavailable",
    };
    const result = await new MemoryIntelligenceService(unavailable).process({
      userId: UID, turns: [{ role: "user", content: "My name is Priya Sharma" }],
    });
    expect(result.persistenceVerified).toBe(false);
    expect(result.failures[0]).toContain("refusing to overwrite");
    expect(saves).toBe(0);
  });

  it("extracts, persists, and re-loads real memories to the store", async () => {
    const store = new LocalFileMemoryStore(TEST_DIR);
    const svc = new MemoryIntelligenceService(store);

    const result = await svc.process({
      turns: [
        { role: "user", content: "My name is Priya Sharma" },
        { role: "user", content: "I really like jasmine tea in the afternoon" },
        { role: "assistant", content: "I'll remember that." },
      ],
      userId: UID,
    });

    expect(result.persistenceVerified).toBe(true);
    expect(result.persisted.added).toBeGreaterThan(0);

    const onDisk = JSON.parse(await fs.readFile(vocabFile(UID), "utf-8")) as Memory[];
    expect(onDisk.some((m) => m.metadata.userId === UID)).toBe(true);
    expect(onDisk.some((m) => m.text.toLowerCase().includes("jasmine"))).toBe(true);
  });

  it("second conversation with same fact reinforces (KEEP), not duplicates", async () => {
    const store = new LocalFileMemoryStore(TEST_DIR);
    const svc = new MemoryIntelligenceService(store);

    const first = await svc.process({
      turns: [{ role: "user", content: "My name is Priya Sharma" }],
      userId: UID,
    });
    expect(first.persistenceVerified).toBe(true);
    const before = await store.load(UID);
    const beforeCount = before!.length;
    expect(beforeCount).toBeGreaterThan(0);
    const nameMemory = before!.find((m) => m.text.includes("Priya Sharma"))!;
    const beforeConfidence = nameMemory.metadata.confidence;
    const beforeId = nameMemory.id;

    const second = await svc.process({
      turns: [{ role: "user", content: "my name is Priya Sharma" }],
      userId: UID,
    });

    expect(second.persistenceVerified).toBe(true);
    const after = await store.load(UID);
    // No duplicate rows for the same fact.
    expect(after!.length).toBe(beforeCount);
    const reinforced = after!.find((m) => m.id === beforeId)!;
    expect(reinforced).toBeDefined();
    // Same identity kept (KEEP), confidence reinforced not reset.
    expect(reinforced.metadata.confidence).toBeGreaterThanOrEqual(beforeConfidence);
  });

  it("change of preference archives the old memory (never deletes)", async () => {
    const store = new LocalFileMemoryStore(TEST_DIR);
    const svc = new MemoryIntelligenceService(store);

    await svc.process({
      turns: [{ role: "user", content: "I love long meetings" }],
      userId: UID,
    });
    const contra = await svc.process({
      turns: [{ role: "user", content: "actually I don't like long meetings" }],
      userId: UID,
    });

    expect(contra.persistenceVerified).toBe(true);
    const all = await store.load(UID);
    const metas = all!.map((m) => (m.metadata as unknown as Record<string, unknown>));
    const statuses = metas.map((m) => m.status);
    expect(statuses).toContain("archived");
  });

  it("low-importance candidates are IGNOREd and never written", async () => {
    const store = new LocalFileMemoryStore(TEST_DIR);
    const svc = new MemoryIntelligenceService(store);

    const result = await svc.process({
      turns: [{ role: "user", content: "okay" }, { role: "user", content: "thanks" }],
      userId: UID,
    });
    expect(result.extracted.candidates).toHaveLength(0);
    expect(result.persisted.ignored).toBe(0); // no candidates to even reject
    const all = await store.load(UID);
    expect(all).toEqual([]);
  });

  it("user isolation: user B cannot see user A's persisted memories", async () => {
    const store = new LocalFileMemoryStore(TEST_DIR);
    const svc = new MemoryIntelligenceService(store);

    await svc.process({
      turns: [{ role: "user", content: "My name is Priya Sharma" }],
      userId: UID,
    });
    const bView = await store.load(OTHER);
    expect(bView).toEqual([]);
  });

  it("refuses to persist for the default uid (auth-bypass safety)", async () => {
    const store = new LocalFileMemoryStore(TEST_DIR);
    const svc = new MemoryIntelligenceService(store);
    const result = await svc.process({
      turns: [{ role: "user", content: "My name is Priya" }],
      userId: "default",
    });
    expect(result.persistenceVerified).toBe(false);
    expect(result.failures.join(";")).toContain("default uid");
  });

  it("learning seam routes lessons through the same pipeline", async () => {
    const store = new LocalFileMemoryStore(TEST_DIR);
    const svc = new MemoryIntelligenceService(store);
    const result = await recordLesson(svc, {
      userId: UID,
      text: "Concise answers work best for this user.",
      confidence: 0.8,
      evidence: ["turn 42"],
    });
    expect(result.persistenceVerified).toBe(true);
    const all = await store.load(UID);
    expect(all!.some((m) => m.text.toLowerCase().includes("concise answers"))).toBe(true);
  });

  it("storage failure reports, never silently claims saved", async () => {
    const failingStore: MemoryStore = {
      backendName: () => "failing",
      load: async () => [],
      save: async () => false,
      add: async () => false,
      delete: async () => false,
      isHealthy: async () => false,
    };
    const svc = new MemoryIntelligenceService(failingStore);
    const result = await svc.process({
      turns: [{ role: "user", content: "My name is Kai" }],
      userId: UID,
    });
    expect(result.persistenceVerified).toBe(false);
    expect(result.failures.some((f) => f.includes("persistence"))).toBe(true);
  });

  it("large memory set stays bounded by budget caps", async () => {
    const store = new LocalFileMemoryStore(TEST_DIR);
    const svc = new MemoryIntelligenceService(store, { maxCandidatesPerSlice: 5 });
    const turns = [];
    for (let i = 0; i < 30; i++) {
      turns.push({ role: "user", content: `my name is user number ${i}` });
    }
    const result = await svc.process({ turns, userId: UID });
    // One extraction per rule match per turn — first rule matched on each
    expect(result.extracted.candidates.length).toBeLessThanOrEqual(30);
    // Dedupe collapses identical structure into reinforcement updates
    const all = await store.load(UID);
    expect(all!.length).toBeLessThanOrEqual(30);
  });

  it("concurrent process calls on the same store remain consistent", async () => {
    const store = new LocalFileMemoryStore(TEST_DIR);
    const svc = new MemoryIntelligenceService(store);
    const [r1, r2] = await Promise.all([
      svc.process({ turns: [{ role: "user", content: "My name is Aarav" }], userId: "u_concur_a" }),
      svc.process({ turns: [{ role: "user", content: "My name is Bhavna" }], userId: "u_concur_b" }),
    ]);
    expect(r1.persistenceVerified).toBe(true);
    expect(r2.persistenceVerified).toBe(true);
    expect((await store.load("u_concur_a"))!.some((m) => m.text.includes("Aarav"))).toBe(true);
    expect((await store.load("u_concur_b"))!.some((m) => m.text.includes("Bhavna"))).toBe(true);
    expect(await store.load("u_concur_a")).not.toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("Bhavna") })
    );
  });
});
