import { describe, expect, it } from "vitest";
import { MockFirestore } from "../persistence/mockFirestore";
import { HealthEngine } from "./engine";
import { FirestoreSelfModelStore } from "./firestoreStore";

describe("Phase 37 Firestore self-model persistence", () => {
  it("uses the established owner path and rejects cross-user reads", async () => {
    const db = new MockFirestore(); const store = new FirestoreSelfModelStore(db);
    const engine = new HealthEngine(store, () => 10);
    await engine.record({ uid: "alice", capabilityId: "memory", category: "memory", verdict: "success", source: "store_probe", authoritative: true });
    expect((await store.load("alice"))?.uid).toBe("alice");
    expect((await store.load("bob"))?.capabilities).toEqual([]);
    expect(db.ops.some((item) => item.path === "users/alice/selfModel/_root")).toBe(true);
  });

  it("fails closed on backend outage", async () => {
    const store = new FirestoreSelfModelStore(new MockFirestore({ failureMode: new Error("offline") }));
    const engine = new HealthEngine(store);
    expect(await engine.record({ uid: "u1", capabilityId: "memory", category: "memory", verdict: "success", source: "store_probe" })).toBeNull();
    expect(await engine.snapshot("u1")).toBeNull();
  });
});

