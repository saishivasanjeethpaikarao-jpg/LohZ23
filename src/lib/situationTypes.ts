import { Goal, Task } from "./goalSystem";
import { Memory } from "./memoryTypes";

// ── Event Types ──

export type SituationEventType =
  | "USER_MESSAGE"
  | "USER_SPEECH"
  | "LOHZ_RESPONSE"
  | "SILENCE"
  | "GOAL_CREATED"
  | "GOAL_UPDATED"
  | "GOAL_COMPLETED"
  | "TASK_CREATED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TOOL_STARTED"
  | "TOOL_COMPLETED"
  | "TOOL_FAILED"
  | "MEMORY_UPDATED"
  | "USER_CORRECTION"
  | "EXPLICIT_FEEDBACK";

export interface SituationEvent {
  type: SituationEventType;
  payload: unknown;
  timestamp: number;
  userId: string;
}

// ── Situation State ──

export type ConversationPhase =
  | "greeting"
  | "exploration"
  | "working"
  | "wrapping_up"
  | "idle";

export type UserActivity =
  | "typing"
  | "speaking"
  | "idle"
  | "reading"
  | "waiting";

export type InteractionMode = "voice" | "text" | "hybrid";

export interface LOHZAction {
  type: "response" | "tool_use" | "question" | "suggestion" | "error";
  description: string;
  timestamp: number;
}

export interface TimeContext {
  timeOfDay: "morning" | "afternoon" | "evening" | "night";
  dayOfWeek: string;
  sessionDuration: number;
  lastActivity: number;
}

export interface SituationState {
  userId: string;
  currentTopic: string | null;
  conversationPhase: ConversationPhase;
  userIntent: string | null;
  userActivity: UserActivity;
  activeGoals: Goal[];
  pendingTasks: Task[];
  relevantMemories: Memory[];
  recentEvents: SituationEvent[];
  recentLOHZActions: LOHZAction[];
  timeContext: TimeContext;
  confidence: number;
  urgency: number;
  interactionMode: InteractionMode;
  messageCount: number;
}

// ── Configuration ──

export interface SituationConfig {
  maxRecentEvents: number;
  maxRecentActions: number;
  idleThresholdMs: number;
  greetingWindowMs: number;
  topicChangeThreshold: number;
  wrappingUpPatterns: string[];
  greetingPatterns: string[];
  correctionPatterns: string[];
  intentKeywords: Record<string, string[]>;
}

export const DEFAULT_SITUATION_CONFIG: SituationConfig = {
  maxRecentEvents: 50,
  maxRecentActions: 20,
  idleThresholdMs: 60_000,
  greetingWindowMs: 120_000,
  topicChangeThreshold: 3,
  wrappingUpPatterns: [
    "thanks", "thank you", "bye", "goodbye", "see you", "that's all",
    "we're done", "finished", "perfect", "great", "awesome", "cool",
  ],
  greetingPatterns: [
    "hello", "hi", "hey", "good morning", "good afternoon", "good evening",
    "howdy", "greetings", "what's up", "sup",
  ],
  correctionPatterns: [
    "actually,", "that's not right", "you're wrong", "incorrect",
    "wrong,", "no, that's", "not quite", "i meant", "i said",
    "let me correct", "that's not what i meant",
  ],
  intentKeywords: {
    question: ["what", "how", "why", "when", "where", "who", "which", "can you", "could you", "is there"],
    request: ["please", "help me", "i need", "can you", "could you", "would you", "i want"],
    complaint: ["problem", "issue", "error", "broken", "doesn't work", "not working", "failed"],
    confirmation: ["yes", "correct", "right", "exactly", "sure", "okay", "ok", "sounds good"],
    negation: ["no", "not", "don't", "doesn't", "can't", "won't", "shouldn't", "never"],
  },
};
