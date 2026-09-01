export type CognitiveMemoryLayer = "working" | "episodic" | "semantic" | "procedural" | "world_state";

export interface CognitiveMemoryLayerPolicy {
  layer: CognitiveMemoryLayer;
  purpose: string;
  examples: string[];
  durability: "request" | "durable";
  authority: string;
}

/** Canonical Phase 35 separation. UserModel remains a derived profile, not a sixth memory layer. */
export const COGNITIVE_MEMORY_LAYERS: readonly CognitiveMemoryLayerPolicy[] = [
  { layer: "working", purpose: "Bounded request and active-task context", examples: ["current request", "active plan step"], durability: "request", authority: "request/session state" },
  { layer: "episodic", purpose: "Timestamped user-scoped events and outcomes", examples: ["verified plan completed", "user conversation event"], durability: "durable", authority: "TemporalService and episodic MemoryStore records" },
  { layer: "semantic", purpose: "Stable learned facts supplied or repeatedly supported by evidence", examples: ["project uses TypeScript"], durability: "durable", authority: "MemoryIntelligenceService with provenance" },
  { layer: "procedural", purpose: "Reusable bounded procedures and lessons", examples: ["verified recovery procedure"], durability: "durable", authority: "procedural MemoryStore records" },
  { layer: "world_state", purpose: "Time-aware assertions about the relevant environment", examples: ["Chrome is open now"], durability: "durable", authority: "WorldModelService verified or user-confirmed assertions" },
] as const;
