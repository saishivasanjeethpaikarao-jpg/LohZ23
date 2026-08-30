export type InteractionMode =
  | "ACTIVE_CONVERSATION"
  | "LISTENING"
  | "THINKING"
  | "WAITING"
  | "QUIET"
  | "PROACTIVE"
  | "TASK_FOCUSED";

export interface ModeTransition {
  mode: InteractionMode;
  timestamp: number;
  reason: string;
}

export interface InteractionModeConfig {
  quietModeTimeoutMs: number;
  waitingTimeoutMs: number;
  taskFocusDetectionThreshold: number;
}

const DEFAULT_CONFIG: InteractionModeConfig = {
  quietModeTimeoutMs: 0,
  waitingTimeoutMs: 60000,
  taskFocusDetectionThreshold: 2,
};

const VALID_TRANSITIONS: Record<InteractionMode, InteractionMode[]> = {
  ACTIVE_CONVERSATION: ["WAITING", "THINKING", "LISTENING", "QUIET", "TASK_FOCUSED"],
  LISTENING: ["THINKING", "ACTIVE_CONVERSATION", "QUIET", "TASK_FOCUSED"],
  THINKING: ["ACTIVE_CONVERSATION", "WAITING", "LISTENING", "QUIET"],
  WAITING: ["ACTIVE_CONVERSATION", "PROACTIVE", "LISTENING", "QUIET", "TASK_FOCUSED"],
  QUIET: ["LISTENING", "WAITING"],
  PROACTIVE: ["ACTIVE_CONVERSATION", "WAITING", "LISTENING", "QUIET"],
  TASK_FOCUSED: ["LISTENING", "WAITING", "ACTIVE_CONVERSATION", "QUIET"],
};

const MODE_CAN_SPEAK: InteractionMode[] = [
  "ACTIVE_CONVERSATION",
  "WAITING",
  "PROACTIVE",
];

const MODE_CAN_INITIATE: InteractionMode[] = [
  "WAITING",
  "LISTENING",
];

const MODE_CAN_BE_PROACTIVE: InteractionMode[] = [
  "WAITING",
  "LISTENING",
  "TASK_FOCUSED",
];

export class InteractionModeTracker {
  private mode: InteractionMode = "LISTENING";
  private history: ModeTransition[] = [];
  private modeStartTime: number = Date.now();
  private config: InteractionModeConfig;

  constructor(config?: Partial<InteractionModeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  transition(newMode: InteractionMode, reason: string): boolean {
    if (newMode === this.mode) {
      this.history.push({ mode: newMode, timestamp: Date.now(), reason });
      return true;
    }

    const allowed = VALID_TRANSITIONS[this.mode];
    if (!allowed.includes(newMode)) {
      return false;
    }

    this.history.push({ mode: newMode, timestamp: Date.now(), reason });
    this.mode = newMode;
    this.modeStartTime = Date.now();
    return true;
  }

  getMode(): InteractionMode {
    return this.mode;
  }

  getTimeInMode(): number {
    return Date.now() - this.modeStartTime;
  }

  canSpeak(): boolean {
    return MODE_CAN_SPEAK.includes(this.mode);
  }

  canInitiate(): boolean {
    return MODE_CAN_INITIATE.includes(this.mode);
  }

  canBeProactive(): boolean {
    return MODE_CAN_BE_PROACTIVE.includes(this.mode);
  }

  getHistory(limit?: number): ModeTransition[] {
    if (limit) {
      return this.history.slice(-limit);
    }
    return [...this.history];
  }

  forceMode(mode: InteractionMode, reason: string): void {
    this.history.push({ mode, timestamp: Date.now(), reason: `forced: ${reason}` });
    this.mode = mode;
    this.modeStartTime = Date.now();
  }

  reset(): void {
    this.mode = "LISTENING";
    this.history = [];
    this.modeStartTime = Date.now();
  }
}
