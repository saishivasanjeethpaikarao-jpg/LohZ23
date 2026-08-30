import {
  SituationState,
  SituationEvent,
  SituationConfig,
  ConversationPhase,
  UserActivity,
  TimeContext,
  LOHZAction,
  DEFAULT_SITUATION_CONFIG,
} from "./situationTypes";
import { Goal, Task } from "./goalSystem";
import { Memory } from "./memoryTypes";

// ── Per-User State Store ──

interface UserSituation {
  state: SituationState;
  sessionStart: number;
  messageCount: number;
  topicHistory: string[];
  lastUserMessageTime: number;
  lastLohzResponseTime: number;
  lastActivityTime: number;
  toolInProgress: string | null;
  hasSeenText: boolean;
  hasSeenVoice: boolean;
  lastSilenceTime: number;
}

function getTimeContext(now: number): TimeContext {
  const date = new Date(now);
  const hour = date.getHours();
  let timeOfDay: TimeContext["timeOfDay"] = "morning";
  if (hour >= 12 && hour < 17) timeOfDay = "afternoon";
  else if (hour >= 17 && hour < 21) timeOfDay = "evening";
  else if (hour >= 21 || hour < 6) timeOfDay = "night";

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return {
    timeOfDay,
    dayOfWeek: days[date.getDay()],
    sessionDuration: 0,
    lastActivity: now,
  };
}

function createDefaultState(userId: string, now: number): SituationState {
  return {
    userId,
    currentTopic: null,
    conversationPhase: "idle",
    userIntent: null,
    userActivity: "idle",
    activeGoals: [],
    pendingTasks: [],
    relevantMemories: [],
    recentEvents: [],
    recentLOHZActions: [],
    timeContext: getTimeContext(now),
    confidence: 0.5,
    urgency: 0,
    interactionMode: "text",
    messageCount: 0,
  };
}

// ── Deterministic Extractors ──

const STOP_WORDS = new Set([
  "the", "is", "in", "at", "which", "on", "a", "an", "and", "or", "but",
  "for", "with", "to", "of", "this", "that", "it", "from", "by", "as",
  "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might",
  "shall", "can", "need", "must", "not", "no", "so", "if", "then",
  "than", "too", "very", "just", "about", "above", "after", "again",
  "all", "also", "any", "because", "before", "between", "both", "each",
  "few", "more", "most", "other", "some", "such", "only", "own", "same",
  "now", "please", "help", "me", "you", "your", "my", "its", "our",
  "tell", "switch", "lets", "let", "check", "talk", "something",
  "things", "what", "where", "when", "how", "why", "there", "here",
  "give", "show", "find", "look", "start", "stop", "make", "create",
]);

function extractTopics(text: string): string[] {
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !STOP_WORDS.has(w));
  const freq: Record<string, number> = {};
  const firstSeen: Record<string, number> = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    freq[w] = (freq[w] || 0) + 1;
    if (!(w in firstSeen)) firstSeen[w] = i;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1] || (firstSeen[a[0]] ?? 0) - (firstSeen[b[0]] ?? 0))
    .slice(0, 3)
    .map(([word]) => word);
}

function detectIntent(text: string, config: SituationConfig): string | null {
  const lower = text.toLowerCase();
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const [intent, keywords] of Object.entries(config.intentKeywords)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = intent;
    }
  }

  return bestMatch;
}

function isGreeting(text: string, config: SituationConfig): boolean {
  const lower = text.toLowerCase().trim();
  return config.greetingPatterns.some(p => lower.startsWith(p) || lower === p);
}

function isWrappingUp(text: string, config: SituationConfig): boolean {
  const lower = text.toLowerCase().trim();
  return config.wrappingUpPatterns.some(p => lower.includes(p));
}

function isCorrection(text: string, config: SituationConfig): boolean {
  const lower = text.toLowerCase();
  return config.correctionPatterns.some(p => lower.includes(p));
}

function classifyTopicShift(currentTopic: string | null, newTopics: string[], threshold: number): boolean {
  if (!currentTopic || newTopics.length === 0) return false;
  const overlap = newTopics.filter(t => currentTopic.toLowerCase().includes(t.toLowerCase()));
  return overlap.length === 0;
}

// ── SituationEngine ──

export class SituationEngine {
  private config: SituationConfig;
  private userSituations: Map<string, UserSituation> = new Map();

  constructor(config: Partial<SituationConfig> = {}) {
    this.config = { ...DEFAULT_SITUATION_CONFIG, ...config };
  }

  // ── Public API ──

  getState(userId: string): SituationState {
    const sit = this.userSituations.get(userId);
    if (!sit) {
      return createDefaultState(userId, Date.now());
    }
    return { ...sit.state };
  }

  processEvent(event: SituationEvent): SituationState {
    const sit = this.getOrCreateSituation(event.userId, event.timestamp);

    // Append to recent events
    sit.state.recentEvents.push(event);
    if (sit.state.recentEvents.length > this.config.maxRecentEvents) {
      sit.state.recentEvents = sit.state.recentEvents.slice(-this.config.maxRecentEvents);
    }

    // Dispatch by event type
    switch (event.type) {
      case "USER_MESSAGE":
        this.handleUserMessage(sit, event);
        break;
      case "USER_SPEECH":
        this.handleUserSpeech(sit, event);
        break;
      case "LOHZ_RESPONSE":
        this.handleLohzResponse(sit, event);
        break;
      case "SILENCE":
        this.handleSilence(sit, event);
        break;
      case "GOAL_CREATED":
      case "GOAL_UPDATED":
      case "GOAL_COMPLETED":
        this.handleGoalEvent(sit, event);
        break;
      case "TASK_CREATED":
      case "TASK_COMPLETED":
      case "TASK_FAILED":
        this.handleTaskEvent(sit, event);
        break;
      case "TOOL_STARTED":
        this.handleToolStarted(sit, event);
        break;
      case "TOOL_COMPLETED":
      case "TOOL_FAILED":
        this.handleToolFinished(sit, event);
        break;
      case "MEMORY_UPDATED":
        this.handleMemoryUpdated(sit, event);
        break;
      case "USER_CORRECTION":
        this.handleUserCorrection(sit, event);
        break;
      case "EXPLICIT_FEEDBACK":
        this.handleExplicitFeedback(sit, event);
        break;
    }

    // Update derived state
    this.updateConversationPhase(sit, event.timestamp);
    this.updateUserActivity(sit, event.timestamp);
    this.updateTimeContext(sit, event.timestamp);
    this.pruneRecentActions(sit);

    return { ...sit.state };
  }

  updateGoals(userId: string, goals: Goal[]): void {
    const sit = this.userSituations.get(userId);
    if (sit) {
      sit.state.activeGoals = goals.filter(g => g.status === "active");
    }
  }

  updateTasks(userId: string, tasks: Task[]): void {
    const sit = this.userSituations.get(userId);
    if (sit) {
      sit.state.pendingTasks = tasks.filter(t => t.status === "pending" || t.status === "in_progress");
    }
  }

  updateMemories(userId: string, memories: Memory[]): void {
    const sit = this.userSituations.get(userId);
    if (sit) {
      sit.state.relevantMemories = memories;
    }
  }

  reset(userId: string): void {
    this.userSituations.delete(userId);
  }

  // ── Event Handlers ──

  private handleUserMessage(sit: UserSituation, event: SituationEvent): void {
    const text = (event.payload as { text?: string })?.text ?? String(event.payload);
    const now = event.timestamp;

    sit.lastUserMessageTime = now;
    sit.lastActivityTime = now;
    sit.messageCount++;
    sit.state.messageCount = sit.messageCount;

    // Topic extraction
    const topics = extractTopics(text);
    const topicChanged = classifyTopicShift(sit.state.currentTopic, topics, this.config.topicChangeThreshold);

    if (topics.length > 0) {
      if (topicChanged) {
        sit.topicHistory.push(topics[0]);
        if (sit.topicHistory.length > 10) sit.topicHistory.shift();
      }
      sit.state.currentTopic = topics[0];
    }

    // Intent
    sit.state.userIntent = detectIntent(text, this.config);

    // Greeting detection
    if (isGreeting(text, this.config) && sit.messageCount <= 2) {
      sit.state.conversationPhase = "greeting";
    }

    // Wrapping up detection
    if (isWrappingUp(text, this.config) && sit.state.conversationPhase === "working") {
      sit.state.conversationPhase = "wrapping_up";
    }

    // Interaction mode
    sit.hasSeenText = true;
    sit.state.interactionMode = sit.hasSeenText && sit.hasSeenVoice ? "hybrid" : sit.hasSeenVoice ? "voice" : "text";
  }

  private handleUserSpeech(sit: UserSituation, event: SituationEvent): void {
    const text = (event.payload as { text?: string })?.text ?? String(event.payload);
    const now = event.timestamp;

    sit.lastUserMessageTime = now;
    sit.lastActivityTime = now;
    sit.messageCount++;
    sit.state.messageCount = sit.messageCount;

    // Topic extraction
    const topics = extractTopics(text);
    if (topics.length > 0) {
      sit.state.currentTopic = topics[0];
    }

    // Intent
    sit.state.userIntent = detectIntent(text, this.config);

    // Interaction mode
    sit.hasSeenVoice = true;
    sit.state.interactionMode = sit.hasSeenText && sit.hasSeenVoice ? "hybrid" : sit.hasSeenVoice ? "voice" : "text";
  }

  private handleLohzResponse(sit: UserSituation, event: SituationEvent): void {
    const now = event.timestamp;
    sit.lastLohzResponseTime = now;
    sit.lastActivityTime = now;

    const payload = event.payload as { description?: string; type?: LOHZAction["type"] };
    sit.state.recentLOHZActions.push({
      type: payload?.type ?? "response",
      description: payload?.description ?? "responded",
      timestamp: now,
    });

    // Transition: greeting → exploration after first LOHZ response
    if (sit.state.conversationPhase === "greeting") {
      sit.state.conversationPhase = "exploration";
    }

    // User becomes "reading" after LOHZ responds
    sit.state.userActivity = "reading";
  }

  private handleSilence(sit: UserSituation, event: SituationEvent): void {
    const now = event.timestamp;
    const silenceDuration = now - sit.lastUserMessageTime;

    if (silenceDuration > this.config.idleThresholdMs) {
      sit.state.userActivity = "idle";
      sit.lastSilenceTime = now;
      // Push lastActivityTime back so updateUserActivity doesn't override
      sit.lastActivityTime = sit.lastUserMessageTime;
      if (sit.state.conversationPhase === "exploration" || sit.state.conversationPhase === "wrapping_up") {
        sit.state.conversationPhase = "idle";
      }
    }
  }

  private handleGoalEvent(sit: UserSituation, event: SituationEvent): void {
    const payload = event.payload as { goals?: Goal[] };
    if (payload?.goals) {
      sit.state.activeGoals = payload.goals.filter(g => g.status === "active");
    }

    if (event.type === "GOAL_COMPLETED") {
      sit.state.urgency = Math.max(0, sit.state.urgency - 0.3);
    }

    if (event.type === "GOAL_CREATED") {
      sit.state.conversationPhase = "working";
    }
  }

  private handleTaskEvent(sit: UserSituation, event: SituationEvent): void {
    const payload = event.payload as { tasks?: Task[] };
    if (payload?.tasks) {
      sit.state.pendingTasks = payload.tasks.filter(
        t => t.status === "pending" || t.status === "in_progress"
      );
    }

    if (event.type === "TASK_COMPLETED") {
      sit.state.urgency = Math.max(0, sit.state.urgency - 0.2);
    }

    if (event.type === "TASK_FAILED") {
      sit.state.urgency = Math.min(1, sit.state.urgency + 0.3);
    }

    if (event.type === "TASK_CREATED") {
      sit.state.conversationPhase = "working";
    }
  }

  private handleToolStarted(sit: UserSituation, event: SituationEvent): void {
    const payload = event.payload as { tool?: string };
    sit.toolInProgress = payload?.tool ?? "unknown";
    sit.state.userActivity = "waiting";

    sit.state.recentLOHZActions.push({
      type: "tool_use",
      description: `started ${payload?.tool ?? "tool"}`,
      timestamp: event.timestamp,
    });
  }

  private handleToolFinished(sit: UserSituation, event: SituationEvent): void {
    const payload = event.payload as { tool?: string; success?: boolean };
    sit.toolInProgress = null;

    sit.state.recentLOHZActions.push({
      type: event.type === "TOOL_FAILED" ? "error" : "tool_use",
      description: `${payload?.tool ?? "tool"} ${event.type === "TOOL_FAILED" ? "failed" : "completed"}`,
      timestamp: event.timestamp,
    });

    if (event.type === "TOOL_FAILED") {
      sit.state.urgency = Math.min(1, sit.state.urgency + 0.2);
    }
  }

  private handleMemoryUpdated(sit: UserSituation, event: SituationEvent): void {
    const payload = event.payload as { memories?: Memory[] };
    if (payload?.memories) {
      sit.state.relevantMemories = payload.memories;
    }
  }

  private handleUserCorrection(sit: UserSituation, event: SituationEvent): void {
    sit.state.urgency = Math.min(1, sit.state.urgency + 0.4);
    sit.state.confidence = Math.max(0, sit.state.confidence - 0.3);

    sit.state.recentLOHZActions.push({
      type: "error",
      description: "user correction received",
      timestamp: event.timestamp,
    });
  }

  private handleExplicitFeedback(sit: UserSituation, event: SituationEvent): void {
    const payload = event.payload as { positive?: boolean; text?: string };
    if (payload?.positive === true) {
      sit.state.confidence = Math.min(1, sit.state.confidence + 0.1);
    } else if (payload?.positive === false) {
      sit.state.confidence = Math.max(0, sit.state.confidence - 0.1);
      sit.state.urgency = Math.min(1, sit.state.urgency + 0.1);
    }
  }

  // ── Derived State Updates ──

  private updateConversationPhase(sit: UserSituation, now: number): void {
    // Don't override greeting or wrapping_up if recently set
    if (sit.state.conversationPhase === "greeting") {
      if (now - sit.lastUserMessageTime < 30_000) return;
    }
    if (sit.state.conversationPhase === "wrapping_up") {
      if (now - sit.lastUserMessageTime < 15_000) return;
    }

    // Idle detection
    const timeSinceActivity = now - sit.lastActivityTime;
    if (timeSinceActivity > this.config.idleThresholdMs) {
      sit.state.conversationPhase = "idle";
      return;
    }

    // Working phase: sustained topic + tool usage + goals/tasks
    if (sit.toolInProgress || sit.state.pendingTasks.length > 0 || sit.state.activeGoals.length > 0) {
      sit.state.conversationPhase = "working";
      return;
    }

    // Exploration: multiple messages, topic changes
    if (sit.messageCount > 2 && sit.topicHistory.length > 1) {
      sit.state.conversationPhase = "exploration";
      return;
    }

    // Default: if messages exist, exploration; else idle
    if (sit.messageCount > 0) {
      sit.state.conversationPhase = "exploration";
    } else {
      sit.state.conversationPhase = "idle";
    }
  }

  private updateUserActivity(sit: UserSituation, now: number): void {
    // If silence just set idle, respect it
    if (sit.lastSilenceTime >= sit.lastUserMessageTime && sit.state.userActivity === "idle") {
      return;
    }

    if (sit.toolInProgress) {
      sit.state.userActivity = "waiting";
      return;
    }

    const timeSinceUserMsg = now - sit.lastUserMessageTime;
    const timeSinceLohzResp = now - sit.lastLohzResponseTime;

    // User just sent a message → typing
    if (timeSinceUserMsg < 5_000) {
      sit.state.userActivity = "typing";
      return;
    }

    // LOHZ just responded, user hasn't replied → reading
    if (timeSinceLohzResp < 30_000 && timeSinceUserMsg > timeSinceLohzResp) {
      sit.state.userActivity = "reading";
      return;
    }

    // Long silence → idle
    if (timeSinceUserMsg > this.config.idleThresholdMs) {
      sit.state.userActivity = "idle";
      return;
    }

    // Default: speaking (user is actively engaged)
    sit.state.userActivity = "speaking";
  }

  private updateTimeContext(sit: UserSituation, now: number): void {
    sit.state.timeContext = {
      ...getTimeContext(now),
      sessionDuration: now - sit.sessionStart,
      lastActivity: sit.lastActivityTime,
    };
  }

  private pruneRecentActions(sit: UserSituation): void {
    if (sit.state.recentLOHZActions.length > this.config.maxRecentActions) {
      sit.state.recentLOHZActions = sit.state.recentLOHZActions.slice(-this.config.maxRecentActions);
    }
  }

  // ── Helpers ──

  private getOrCreateSituation(userId: string, now: number): UserSituation {
    let sit = this.userSituations.get(userId);
    if (!sit) {
      sit = {
        state: createDefaultState(userId, now),
        sessionStart: now,
        messageCount: 0,
        topicHistory: [],
        lastUserMessageTime: 0,
        lastLohzResponseTime: 0,
        lastActivityTime: now,
        toolInProgress: null,
        hasSeenText: false,
        hasSeenVoice: false,
        lastSilenceTime: 0,
      };
      this.userSituations.set(userId, sit);
    }
    return sit;
  }
}

export function createSituationEngine(config?: Partial<SituationConfig>): SituationEngine {
  return new SituationEngine(config);
}
