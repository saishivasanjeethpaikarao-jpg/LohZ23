import { CognitiveState, CognitiveDecision, DecisionReason } from "./cognitiveState";

export interface BrainSnapshot {
  timestamp: number;
  decision: CognitiveDecision | null;
  decisionReason: string | null;
  confidence: number;
  urgency: number;
  emotionalContext: string;
  conversationState: string;
  workingMemorySize: number;
  relevantMemoryCount: number;
  pendingTaskCount: number;
  silenceDuration: number;
  lastSpeechAge: number;
  topic: string | null;
  intent: string | null;
  toolQueue: string[];
}

export interface DebugEntry {
  time: string;
  label: string;
  value: string;
}

export class BrainObservability {
  private history: BrainSnapshot[] = [];
  private maxHistory = 50;

  capture(state: CognitiveState, decision: CognitiveDecision | null, reason: string | null): BrainSnapshot {
    const snap: BrainSnapshot = {
      timestamp: Date.now(),
      decision,
      decisionReason: reason,
      confidence: state.confidence,
      urgency: state.urgency,
      emotionalContext: state.emotionalContext,
      conversationState: state.conversationState,
      workingMemorySize: state.workingMemory.currentConversation.length,
      relevantMemoryCount: state.relevantMemories.length,
      pendingTaskCount: state.pendingTasks.length,
      silenceDuration: state.silenceDuration,
      lastSpeechAge: Date.now() - state.lastLohzSpeech,
      topic: state.currentTopic,
      intent: state.userIntent,
      toolQueue: state.workingMemory.recentToolActions.slice(-3).map((a) => a.tool),
    };
    this.history.push(snap);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    return snap;
  }

  toDebugLines(snap: BrainSnapshot): DebugEntry[] {
    return [
      { time: new Date(snap.timestamp).toLocaleTimeString(), label: "Decision", value: snap.decision ?? "PENDING" },
      { time: "", label: "Reason", value: snap.decisionReason ?? "—" },
      { time: "", label: "Confidence", value: snap.confidence.toFixed(2) },
      { time: "", label: "Urgency", value: snap.urgency.toFixed(2) },
      { time: "", label: "Emotion", value: snap.emotionalContext },
      { time: "", label: "State", value: snap.conversationState },
      { time: "", label: "Topic", value: snap.topic ?? "none" },
      { time: "", label: "Intent", value: snap.intent ?? "none" },
      { time: "", label: "Conv turns", value: String(snap.workingMemorySize) },
      { time: "", label: "Memories", value: String(snap.relevantMemoryCount) },
      { time: "", label: "Pending", value: String(snap.pendingTaskCount) },
      { time: "", label: "Silence", value: `${(snap.silenceDuration / 1000).toFixed(1)}s` },
      { time: "", label: "Last speech", value: `${(snap.lastSpeechAge / 1000).toFixed(1)}s ago` },
      { time: "", label: "Tools", value: snap.toolQueue.join(", ") || "none" },
    ];
  }

  getLatest(): BrainSnapshot | null {
    return this.history.at(-1) ?? null;
  }

  getHistory(): BrainSnapshot[] {
    return [...this.history];
  }

  clear(): void {
    this.history = [];
  }
}

export default BrainObservability;