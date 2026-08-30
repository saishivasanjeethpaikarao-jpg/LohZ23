export interface Memory {
  id: string;
  layer: "working" | "episodic" | "semantic" | "user_model" | "procedural";
  category: "identity" | "preference" | "goal" | "project" | "relationship" | "emotional" | "behavior" | "concept" | "fact" | "strategy" | "workflow" | "skill";
  text: string;
  createdAt: string;
  updatedAt: string;
  metadata: MemoryMetadata;
}

export type MemoryCategory = Memory["category"];
export type MemoryLayer = Memory["layer"];

export interface MemoryMetadata {
  importance: number;
  confidence: number;
  source: "conversation" | "tool_result" | "reflection" | "user_correction" | "observation";
  timestamp: number;
  lastAccessed: number;
  lastReinforced: number;
  category: string;
  relationships: string[];
  userId: string;
}

export interface MemoryTransaction {
  action: "ADD" | "UPDATE" | "REMOVE";
  id: string;
  layer: MemoryLayer;
  category: MemoryCategory;
  text: string;
  metadata: Partial<MemoryMetadata>;
}

export interface ConsolidationCandidate {
  sourceConversation: ConversationTurn[];
  extractedFacts: ExtractedFact[];
  timestamp: number;
}

export interface ExtractedFact {
  text: string;
  category: MemoryCategory;
  layer: MemoryLayer;
  importance: number;
  confidence: number;
  evidence: string[];
  contradicts: string[];
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  userId: string;
  layer?: MemoryLayer;
  category?: MemoryCategory;
  query?: string;
  limit?: number;
  minImportance?: number;
  minConfidence?: number;
}

export interface UserModel {
  userId: string;
  preferences: Record<string, unknown>;
  communicationStyle: "concise" | "detailed" | "casual" | "formal" | "technical";
  recurringInterests: string[];
  ongoingProjects: string[];
  goals: string[];
  frequentlyUsedTools: string[];
  interactionPatterns: InteractionPattern[];
  lastUpdated: number;
}

export interface InteractionPattern {
  pattern: string;
  frequency: number;
  lastSeen: number;
  context: string;
}

export interface ProceduralMemory {
  id: string;
  name: string;
  description: string;
  steps: ProceduralStep[];
  successRate: number;
  useCount: number;
  lastUsed: number;
  context: string;
  tags: string[];
}

export interface ProceduralStep {
  action: string;
  tool?: string;
  params?: Record<string, unknown>;
  expectedOutcome: string;
  alternatives?: string[];
}