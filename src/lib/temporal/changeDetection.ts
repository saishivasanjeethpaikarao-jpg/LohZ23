/**
 * Phase 25 — change detection.
 *
 * Pure diffing between two UserModelBundles. Emits temporal event
 * descriptors ONLY for meaningful structured changes (§12) — trivial
 * messages never reach this layer, so no noise events are possible.
 */
import type { UserModelBundle } from "../userModel/types";
import type { TemporalEvent } from "./types";
import crypto from "crypto";

export function newEventId(now: number, seed: string): string {
  return crypto.createHash("sha1").update(`${now}|${seed}`).digest("hex").slice(0, 12);
}

function snippet(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= 80 ? t : t.slice(0, 79) + "…";
}

export interface ChangeContext {
  nowUtc: number;
  userId: string;
}

/**
 * Diff two bundles into unpersisted TemporalEvents. `prev` may be null
 * for first-observation (emits project_started / preference baseline
 * events only when curr has content).
 */
export function detectChanges(prev: UserModelBundle | null, curr: UserModelBundle, ctx: ChangeContext): TemporalEvent[] {
  const out: TemporalEvent[] = [];
  const base = { userId: ctx.userId, source: "observation" as const, confidence: 0.8 };

  const mk = (
    type: TemporalEvent["type"],
    seedExtra: string,
    fields: Partial<TemporalEvent> = {},
    importance = 0.6
  ): TemporalEvent => ({
    id: newEventId(ctx.nowUtc, `${type}|${seedExtra}`),
    type,
    timestamp: ctx.nowUtc,
    ...base,
    importance,
    ...fields,
  });

  // ── Preference changes ──
  for (const [key, slot] of Object.entries(curr.preferences)) {
    const before = prev?.preferences[key];
    if (!before) continue; // brand-new key on first observation — not a "change"
    if (before.current.value !== slot.current.value) {
      out.push(
        mk("preference_changed", `pref|${key}`, {
          projectKey: undefined,
          description: snippet(`preference ${key}: ${before.current.value} → ${slot.current.value}`),
          memoryId: slot.current.evidenceMemoryIds[slot.current.evidenceMemoryIds.length - 1],
          confidence: Math.max(slot.current.confidence, 0.6),
        }, 0.75)
      );
    }
  }

  // ── Project lifecycle ──
  for (const p of curr.projects) {
    const before = prev?.projects.find((x) => x.key === p.key);
    if (!before) {
      if (!prev) continue; // first observation baseline
      out.push(mk("project_started", `proj|${p.key}`, { projectKey: p.key, description: snippet(p.displayName) }, 0.7));
      continue;
    }
    if (before.status !== p.status) {
      const type =
        p.status === "paused" ? "project_paused"
        : p.status === "completed" ? "project_completed"
        : p.status === "active" && (before.status === "paused" || before.stale) ? "project_resumed"
        : p.status === "active" ? "project_activity"
        : null;
      if (type) {
        out.push(mk(type, `proj|${p.key}|${p.status}`, { projectKey: p.key, description: snippet(p.displayName) }, 0.7));
      }
    } else if (p.lastActivity > before.lastActivity + 1000 && p.status === "active") {
      out.push(mk("project_activity", `projact|${p.key}|${p.lastActivity}`, { projectKey: p.key, description: snippet(p.displayName) }, 0.5));
    }
  }

  // ── Goal references (completion is caller-asserted via goal_completed elsewhere;
  //    here we only detect reference-set growth) ──
  if (prev) {
    const addedGoals = curr.activeGoalIds.filter((g) => !prev.activeGoalIds.includes(g));
    for (const g of addedGoals) {
      out.push(mk("goal_created", `goal|${g}`, { goalId: g }, 0.65));
    }
  }

  return out;
}
