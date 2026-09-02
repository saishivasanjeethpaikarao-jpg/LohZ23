export type CognitiveDecision = "SPEAK" | "LISTEN" | "WAIT" | "ASK" | "ACT" | "IGNORE";
export type UnifiedCognitiveStatus = "SUCCESS" | "FAILED" | "UNCERTAIN" | "NEEDS_USER" | "BLOCKED";

export interface DecisionReason {
  decision: CognitiveDecision;
  reason: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export interface CognitiveState {
  currentTopic: string | null;
  userIntent: string | null;
  emotionalContext: "neutral" | "positive" | "negative" | "curious" | "frustrated" | "excited";
  activeGoal: string | null;
  workingMemory: WorkingMemory;
  relevantMemories: MemoryReference[];
  candidateActions: CandidateAction[];
  confidence: number;
  urgency: number;
  lastUserActivity: number;
  lastLohzSpeech: number;
  silenceDuration: number;
  conversationState: "active" | "paused" | "ended" | "awaiting_response";
  status?: UnifiedCognitiveStatus;
  pendingTasks: PendingTask[];
}

export interface WorkingMemory {
  currentConversation: ConversationTurn[];
  activeTask: string | null;
  recentToolActions: ToolAction[];
  contextSignals: ContextSignal[];
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ToolAction {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  timestamp: number;
  success: boolean;
}

export interface ContextSignal {
  type: "voice_activity" | "user_typing" | "screen_change" | "app_focus" | "silence";
  value: unknown;
  timestamp: number;
}

export interface MemoryReference {
  id: string;
  layer: "working" | "episodic" | "semantic" | "procedural";
  content: string;
  relevance: number;
  metadata: MemoryMetadata;
}

export interface MemoryMetadata {
  importance: number;
  confidence: number;
  source: "conversation" | "tool_result" | "reflection" | "user_correction" | "observation";
  timestamp: number;
  lastAccessed: number;
  lastReinforced: number;
  category: string;
  relationships: string[];
}

export interface CandidateAction {
  type: CognitiveDecision;
  description: string;
  priority: number;
  estimatedValue: number;
  requiredTools?: string[];
  preconditions?: string[];
}

export interface PendingTask {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  createdAt: number;
  updatedAt: number;
  priority: number;
  relatedGoal?: string;
}

export interface CognitiveEvent {
  type: "user_message" | "voice_transcript" | "speech_start" | "speech_end" | "app_state_change" | "timer" | "tool_result" | "task_completion" | "meaningful_silence" | "external_event" | "scheduled_reflection";
  payload: unknown;
  timestamp: number;
  significance: "low" | "medium" | "high" | "critical";
}

export const DEFAULT_COGNITIVE_STATE: CognitiveState = {
  currentTopic: null,
  userIntent: null,
  emotionalContext: "neutral",
  activeGoal: null,
  workingMemory: {
    currentConversation: [],
    activeTask: null,
    recentToolActions: [],
    contextSignals: [],
  },
  relevantMemories: [],
  candidateActions: [],
  confidence: 0.5,
  urgency: 0,
  lastUserActivity: Date.now(),
  lastLohzSpeech: 0,
  silenceDuration: 0,
  conversationState: "active",
  status: "UNCERTAIN",
  pendingTasks: [],
};
