// ── Phase 19: Unified Event Bus ──
// Typed, deduplicated, per-user event transport for the cognitive loop.

export type LoopEventType =
  | "user_message"
  | "voice_transcript"
  | "silence"
  | "tool_started"
  | "tool_result"
  | "goal_change"
  | "memory_update"
  | "error"
  | "external_event"
  | "speech_start"
  | "speech_end"
  | "task_completed";

export type EventSource = "user" | "voice" | "tool" | "system" | "scheduler" | "external";

export interface LoopEvent {
  eventId: string;
  userId: string;
  timestamp: number;
  type: LoopEventType;
  payload: unknown;
  source: EventSource;
}

export interface EventBusConfig {
  dedupWindowMs: number;
  maxSeenEvents: number;
  maxQueueSize: number;
  maxEventsPerDrain: number;
}

export const DEFAULT_EVENT_BUS_CONFIG: EventBusConfig = {
  dedupWindowMs: 2000,
  maxSeenEvents: 500,
  maxQueueSize: 200,
  maxEventsPerDrain: 50,
};

export interface EventBusStats {
  published: number;
  duplicatesDropped: number;
  overflowDropped: number;
  invalidRejected: number;
}

type EventHandler = (event: LoopEvent) => void;

export class EventBus {
  private config: EventBusConfig;
  private handlers = new Set<EventHandler>();
  private seenIdSet = new Set<string>();
  private seenIdOrder: string[] = [];
  private recentContent = new Map<string, number>();
  private queue: LoopEvent[] = [];
  private draining = false;
  private stats: EventBusStats = {
    published: 0,
    duplicatesDropped: 0,
    overflowDropped: 0,
    invalidRejected: 0,
  };

  constructor(config: Partial<EventBusConfig> = {}) {
    this.config = { ...DEFAULT_EVENT_BUS_CONFIG, ...config };
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  publish(event: LoopEvent): boolean {
    if (!this.isValid(event)) {
      this.stats.invalidRejected++;
      return false;
    }

    if (this.seenIdSet.has(event.eventId)) {
      this.stats.duplicatesDropped++;
      return false;
    }

    const contentKey = `${event.userId}|${event.type}|${safeStableKey(event.payload)}`;
    const lastSeen = this.recentContent.get(contentKey);
    const now = event.timestamp || Date.now();
    if (lastSeen !== undefined && now - lastSeen < this.config.dedupWindowMs) {
      this.recentContent.set(contentKey, now);
      this.stats.duplicatesDropped++;
      return false;
    }

    this.rememberId(event.eventId);
    this.recentContent.set(contentKey, now);
    this.stats.published++;

    if (this.queue.length >= this.config.maxQueueSize) {
      this.queue.shift();
      this.stats.overflowDropped++;
    }
    this.queue.push(event);

    if (!this.draining) {
      this.flush();
    }
    return true;
  }

  /**
   * Deliver queued events to subscribers synchronously.
   * Bounded by maxEventsPerDrain to stop runaway generation loops.
   */
  flush(maxEvents: number = this.config.maxEventsPerDrain): number {
    if (this.draining) return 0;
    this.draining = true;
    let processed = 0;
    try {
      while (this.queue.length > 0 && processed < maxEvents) {
        const event = this.queue.shift()!;
        processed++;
        for (const handler of [...this.handlers]) {
          try {
            handler(event);
          } catch {
            // A faulty subscriber must never break the loop.
          }
        }
      }
    } finally {
      this.draining = false;
    }
    return processed;
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getStats(): EventBusStats {
    return { ...this.stats };
  }

  reset(): void {
    this.handlers.clear();
    this.seenIdSet.clear();
    this.seenIdOrder = [];
    this.recentContent.clear();
    this.queue = [];
    this.draining = false;
    this.stats = { published: 0, duplicatesDropped: 0, overflowDropped: 0, invalidRejected: 0 };
  }

  private isValid(event: LoopEvent): boolean {
    return (
      typeof event.eventId === "string" &&
      event.eventId.length > 0 &&
      typeof event.userId === "string" &&
      event.userId.length > 0 &&
      typeof event.type === "string" &&
      event.type.length > 0 &&
      typeof event.source === "string" &&
      event.source.length > 0 &&
      typeof event.timestamp === "number" &&
      Number.isFinite(event.timestamp)
    );
  }

  private rememberId(id: string): void {
    if (this.seenIdSet.has(id)) return;
    this.seenIdSet.add(id);
    this.seenIdOrder.push(id);
    while (this.seenIdOrder.length > this.config.maxSeenEvents) {
      const oldest = this.seenIdOrder.shift();
      if (oldest !== undefined) this.seenIdSet.delete(oldest);
    }
  }
}

function safeStableKey(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  try {
    return stableKey(value);
  } catch {
    return "[unserializable]";
  }
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([k, v]) => `${k}:${stableKey(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

let eventIdCounter = 0;

export function makeEvent(
  partial: Partial<LoopEvent> & Pick<LoopEvent, "userId" | "type">
): LoopEvent {
  eventIdCounter += 1;
  return {
    eventId: partial.eventId ?? `evt_${Date.now()}_${eventIdCounter}`,
    userId: partial.userId,
    timestamp: partial.timestamp ?? Date.now(),
    type: partial.type,
    payload: partial.payload ?? null,
    source: partial.source ?? "system",
  };
}
