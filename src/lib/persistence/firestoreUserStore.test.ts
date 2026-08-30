import { describe, it, expect, beforeEach } from "vitest";
import { FirestoreUserStoreImpl } from "./firestoreUserStore";
import { MockFirestore } from "./mockFirestore";
import { FirestoreMemoryStore } from "./firestoreMemoryStore";
import type { Memory } from "../memoryTypes";
import type { UserInteractionPreferences } from "../userPreferences";

function makeMemory(uid: string, id: string, text: string): Memory {
  const ts = new Date().toISOString();
  return {
    id,
    layer: "semantic",
    category: "preference",
    text,
    createdAt: ts,
    updatedAt: ts,
    metadata: {
      importance: 0.5,
      confidence: 0.8,
      source: "conversation",
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      lastReinforced: Date.now(),
      category: "preference",
      relationships: [],
      userId: uid,
    },
  };
}

function makePrefs(uid: string): UserInteractionPreferences {
  return {
    userId: uid,
    proactiveFrequency: "moderate",
    conversationStyle: "balanced",
    quietHoursEnabled: false,
    quietHoursStart: 22,
    quietHoursEnd: 7,
    allowTaskReminders: true,
    allowMemorySharing: true,
    maxProactivePerHour: 3,
    interruptionTolerance: "medium",
    lastUpdated: Date.now(),
  };
}

describe("FirestoreUserStore (mock backend)", () => {
  let db: MockFirestore;
  let store: FirestoreUserStoreImpl;

  beforeEach(() => {
    db = new MockFirestore();
    store = new FirestoreUserStoreImpl({ db, log: () => undefined });
  });

  it("creates a user profile and reads it back", async () => {
    const created = await store.ensureProfile("alice", "Alice");
    expect(created).not.toBeNull();
    expect(created!.uid).toBe("alice");
    expect(created!.displayName).toBe("Alice");
    expect(created!.schemaVersion).toBe(1);

    const fetched = await store.getProfile("alice");
    expect(fetched!.uid).toBe("alice");

    // ensureProfile twice updates lastSeenAt, does not duplicate
    const again = await store.ensureProfile("alice");
    expect(again!.createdAt).toBe(created!.createdAt);
    expect(again!.lastSeenAt).toBeGreaterThanOrEqual(created!.lastSeenAt);
  });

  it("stores, retrieves, updates, and deletes memories", async () => {
    const m = makeMemory("bob", "m1", "Bob likes squash");
    expect(await store.putMemory("bob", m)).toBe(true);

    let list = await store.listMemories("bob");
    expect(list).toHaveLength(1);
    expect(list![0].text).toBe("Bob likes squash");

    // update: same id, new text
    const m2 = { ...m, text: "Bob prefers squash and tennis", updatedAt: "2026-01-01" };
    expect(await store.putMemory("bob", m2)).toBe(true);
    list = await store.listMemories("bob");
    expect(list).toHaveLength(1);
    expect(list![0].text).toContain("tennis");

    expect(await store.deleteMemory("bob", "m1")).toBe(true);
    list = await store.listMemories("bob");
    expect(list).toHaveLength(0);

    // deleting a missing id is a no-op, still true
    expect(await store.deleteMemory("bob", "nonexistent")).toBe(true);
  });

  it("rejects memory writes whose metadata.userId mismatches the path uid", async () => {
    // Cross-user write attempt: writing bob's memory under alice's path
    const foreign = makeMemory("bob", "evil1", "injected");
    expect(await store.putMemory("alice", foreign)).toBe(false);
    expect(await store.replaceMemories("alice", [makeMemory("alice", "ok", "fine"), foreign])).toBe(false);
    expect(await store.listMemories("alice")).toHaveLength(0);
  });

  it("isolates user A and user B completely", async () => {
    await store.ensureProfile("userA");
    await store.ensureProfile("userB");
    await store.putMemory("userA", makeMemory("userA", "a1", "Alice paints"));
    await store.putMemory("userB", makeMemory("userB", "b1", "Bob lifts"));

    expect((await store.listMemories("userA"))!.map((m) => m.id)).toEqual(["a1"]);
    expect((await store.listMemories("userB"))!.map((m) => m.id)).toEqual(["b1"]);

    // B deleting A's memory must not work under A's namespace and vice versa:
    // deleting under userB only affects userB docs.
    await store.deleteMemory("userB", "a1"); // no-op (wrong namespace)
    expect(await store.listMemories("userA")).toHaveLength(1);

    // Preferences isolation
    await store.setPreferences("userA", makePrefs("userA"));
    expect(await store.getPreferences("userB")).toBeNull();
  });

  it("persists preferences and cognitive state per user", async () => {
    await store.setPreferences("cara", makePrefs("cara"));
    const prefs = await store.getPreferences("cara");
    expect(prefs!.userId).toBe("cara");
    expect(prefs!.conversationStyle).toBe("balanced");

    // refuse mismatching uid in payload
    expect(await store.setPreferences("cara", { ...makePrefs("dave") })).toBe(false);

    expect(await store.setCognitiveState("cara", {
      uid: "cara",
      cognitiveState: { mood: "neutral", focus: 0.5 },
      turnsSinceReflection: 3,
      pendingActions: [],
      updatedAt: Date.now(),
    })).toBe(true);
    const cs = await store.getCognitiveState("cara");
    expect(cs!.turnsSinceReflection).toBe(3);
  });

  it("returns null (never throws) when the backend is down", async () => {
    db.failureMode = new Error("firestore unavailable");
    expect(await store.getProfile("nobody")).toBeNull();
    expect(await store.listMemories("nobody")).toBeNull();
    expect(await store.ensureProfile("nobody")).toBeNull();
    expect(await store.putMemory("nobody", makeMemory("nobody", "x", "y"))).toBe(false);
    expect(await store.deleteMemory("nobody", "x")).toBe(false);
    expect(await store.setPreferences("nobody", makePrefs("nobody"))).toBe(false);
    expect(await store.isHealthy()).toBe(false);

    // Recovering the backend restores normal behavior.
    db.failureMode = null;
    expect(await store.isHealthy()).toBe(true);
    expect(await store.ensureProfile("nobody")).not.toBeNull();
  });

  it("rejects unsafe uids before they reach the database", () => {
    expect(() => store.getProfile("a/b")).rejects.toThrow();
    expect(() => store.getProfile("../escape")).rejects.toThrow();
    expect(() => store.getProfile("")).rejects.toThrow();
  });
});

describe("FirestoreMemoryStore", () => {
  let db: MockFirestore;
  let userStore: FirestoreUserStoreImpl;

  beforeEach(() => {
    db = new MockFirestore();
    userStore = new FirestoreUserStoreImpl({ db, log: () => undefined });
  });

  it("refuses any cross-uid operation at the wrapper level", async () => {
    const aliceStore = new FirestoreMemoryStore(userStore, "alice");
    expect(await aliceStore.load("bob")).toBeNull();
    expect(await aliceStore.save("bob", [])).toBe(false);
    expect(await aliceStore.add("bob", makeMemory("bob", "x", "y"))).toBe(false);
    expect(await aliceStore.delete("bob", "x")).toBe(false);
  });

  it("refuses to add a memory stamped with a different userId", async () => {
    const aliceStore = new FirestoreMemoryStore(userStore, "alice");
    expect(await aliceStore.add("alice", makeMemory("mallory", "x", "y"))).toBe(false);
    expect(await userStore.listMemories("alice")).toHaveLength(0);
    expect(await userStore.listMemories("mallory")).toHaveLength(0);
  });

  it("constructing without a uid throws", () => {
    expect(() => new FirestoreMemoryStore(userStore, "")).toThrow();
  });
});
