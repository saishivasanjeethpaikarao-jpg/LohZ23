/**
 * Phase 24 — Persistent User Model + World State types.
 *
 * Distinction from memory (Phase 23): memory answers "what information
 * do we have?"; the user/world model answers "what is currently true,
 * relevant, active, uncertain, or changing?".
 *
 * The model is a COMPACT DERIVED representation — it references memory
 * IDs as evidence instead of copying memory content, distinguishes
 * CURRENT/RECENT/ONGOING/HISTORICAL/UNCERTAIN, and never destroys
 * useful history (superseded values are kept in bounded `previous`
 * lists). Privacy: a hard denylist prevents inferring sensitive
 * attributes (see PRIVACY_DENYLIST).
 */

/** Temporal qualification for every derived attribute. */
export type TemporalStatus =
  | "current"
  | "recent"
  | "ongoing"
  | "historical"
  | "uncertain";

/** Epistemic qualification — how well-evidenced the attribute is. */
export type AttributeState =
  | "confirmed"
  | "updated"
  | "uncertain"
  | "conflicted";

export type ProjectStatus = "active" | "paused" | "completed" | "archived";

export type EvidenceSource = "explicit" | "derived" | "observed";

/**
 * A single derived attribute value with full provenance. Evidence is
 * stored as MEMORY ID REFERENCES — never copies of memory content.
 */
export interface AttributedValue<T = string> {
  value: T;
  confidence: number; // 0..1, evidence-based
  state: AttributeState;
  temporalStatus: TemporalStatus;
  source: EvidenceSource;
  updatedAt: number;
  evidenceMemoryIds: string[];
}

/** A superseded value — kept so history is never destroyed. */
export interface SupersededValue<T = string> {
  value: T;
  supersededAt: number;
  reason: string;
  evidenceMemoryIds: string[];
  /** Confidence the OLD value had when it was current. */
  confidence: number;
}

/** One preference slot: current value + bounded supersession history. */
export interface PreferenceSlot {
  current: AttributedValue;
  previous: SupersededValue[];
}

/** Ongoing project continuity — compact, reference-based. */
export interface UserProject {
  /** Normalized project key (lowercased slug). */
  key: string;
  displayName: string;
  status: ProjectStatus;
  priority: number; // 0..1
  currentFocus: string | null;
  lastActivity: number;
  relatedGoalIds: string[];
  relatedMemoryIds: string[];
  confidence: number;
  stale: boolean;
  state: AttributeState;
}

/** Bounded world-state event entry. */
export interface WorldEvent {
  kind: string;
  text: string; // bounded snippet
  at: number;
}

/** Time context snapshot attached at write time. */
export interface TimeContext {
  hourOfDay: number;
  dayOfWeek: number;
  recordedAt: number;
}

/**
 * Bounded situation abstraction. NOT a model of the entire world —
 * only what LOHZ's current operation needs.
 */
export interface WorldState {
  currentActivity: string | null;
  activeProjectKey: string | null;
  interactionMode: "voice" | "text" | "hybrid" | null;
  timeContext: TimeContext;
  pendingTaskCount: number;
  /** References into the existing GoalSystem — never a goal copy. */
  activeGoalIds: string[];
  recentEvents: WorldEvent[];
  environmentContext: Record<string, string>;
  updatedAt: number;
}

/** The persistent, compact user model. */
export interface UserModelBundle {
  uid: string;
  schemaVersion: number;
  /** Bounded identity attributes (name, role, ...). */
  identity: Record<string, AttributedValue>;
  /** Bounded preference slots (responseLength, proactivity, style, ...). */
  preferences: Record<string, PreferenceSlot>;
  /** Ongoing projects (bounded, multi-project capable). */
  projects: UserProject[];
  /** Long-term interests (bounded unique strings). */
  interests: string[];
  /** References into GoalSystem — never duplicated goals. */
  activeGoalIds: string[];
  world: WorldState;
  createdAt: number;
  updatedAt: number;
}

/** Explicit resource bounds — the model must never grow unbounded. */
export interface UserModelLimits {
  identityKeys: number;
  preferenceKeys: number;
  projects: number;
  interests: number;
  activeGoalIds: number;
  evidencePerAttribute: number;
  previousPerPreference: number;
  recentEvents: number;
  environmentKeys: number;
  relatedMemoryIdsPerProject: number;
  relatedGoalIdsPerProject: number;
}

export const USER_MODEL_LIMITS: UserModelLimits = {
  identityKeys: 6,
  preferenceKeys: 20,
  projects: 8,
  interests: 10,
  activeGoalIds: 10,
  evidencePerAttribute: 5,
  previousPerPreference: 3,
  recentEvents: 10,
  environmentKeys: 5,
  relatedMemoryIdsPerProject: 8,
  relatedGoalIdsPerProject: 5,
};

/** Staleness rules: reduce confidence, mark STALE — never delete. */
export const STALE_PROJECT_DAYS = 14;
export const STALE_CONFIDENCE_FACTOR = 0.7;
export const MIN_STALE_CONFIDENCE = 0.2;

/**
 * Privacy denylist (§15). Candidates matching these patterns are NEVER
 * written into the derived model. This is a deliberate guard against
 * hidden psychological/personality profiling — observable interaction
 * preferences and project context are in scope; protected
 * characteristics are not.
 */
export const PRIVACY_DENYLIST: RegExp[] = [
  /\bpolitic|\bdemocrat\b|\brepublican\b|\bliberal\b|\bconservative\b|\belection|\bvot(?:er|es?|ed|ing)\b/i,
  /\breligio|\bchristian|\bmuslim|\bhindu|\bbuddhis|\bjewish|\batheist|\bcatholic|\bmosque\b/i,
  /\bgay\b|\blesbian\b|\bbisexual\b|\btransgender\b|\bqueer\b|\bsexual orientation/i,
  /\bdiagnos|\bdiabet|\bcancer\b|\bdepress(?:ion|ed)?\b|\banxiety disorder|\bmedicat|\bprescript\b|\bhiv\b|\baids\b|\bdisabilit/i,
  /\brace\b|\bethnic|\bimmigration status|\bcitizenship\b/i,
];

export function isSensitiveTopic(text: string): boolean {
  return PRIVACY_DENYLIST.some((re) => re.test(text));
}

export const USER_MODEL_SCHEMA_VERSION = 1;

export function createUserModelBundle(uid: string, now = Date.now()): UserModelBundle {
  return {
    uid,
    schemaVersion: USER_MODEL_SCHEMA_VERSION,
    identity: {},
    preferences: {},
    projects: [],
    interests: [],
    activeGoalIds: [],
    world: {
      currentActivity: null,
      activeProjectKey: null,
      interactionMode: null,
      timeContext: { hourOfDay: new Date(now).getHours(), dayOfWeek: new Date(now).getDay(), recordedAt: now },
      pendingTaskCount: 0,
      activeGoalIds: [],
      recentEvents: [],
      environmentContext: {},
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}
