import { randomUUID } from "node:crypto";
import type { PlanStep } from "../planner/types";
import type { Observation } from "../observation/types";
import { sanitizeEvidence } from "../observation/types";
import { isSensitiveTopic } from "../userModel/types";
import { verifiedObservationToAssertion } from "./observationMapper";
import type { WorldStateStore } from "./store";
import {
  DEFAULT_WORLD_DECAY, WORLD_MODEL_LIMITS, isAuthoritativeVerification,
  type WorldAssertion, type WorldAssertionInput, type WorldDecayPolicy,
  type WorldMutationResult, type WorldQuery, type WorldValue,
} from "./types";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const clip = (value: unknown, max: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const sameValue = (a: WorldValue, b: WorldValue) => JSON.stringify(a) === JSON.stringify(b);
const slot = (a: Pick<WorldAssertion, "entity" | "relation" | "scope">) => `${a.scope}|${a.entity.id}|${a.relation}`;

function reliability(kind: WorldAssertionInput["source"]["kind"], verification: WorldAssertionInput["verification"]): number {
  if (kind === "user_correction" && verification === "USER_CONFIRMED") return 5;
  if (kind === "verified_observation" && verification === "VERIFIED") return 4;
  if (kind === "user_explicit" && verification === "USER_CONFIRMED") return 3;
  if (kind === "system" && verification === "VERIFIED") return 2;
  return 0;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9_:.\\/-]+/).filter((x) => x.length > 2).slice(0, 40));
}

export class WorldModelService {
  private readonly decay: WorldDecayPolicy;
  constructor(private readonly store: WorldStateStore, decay: Partial<WorldDecayPolicy> = {}) {
    this.decay = {
      defaultByScopeMs: { ...DEFAULT_WORLD_DECAY.defaultByScopeMs, ...(decay.defaultByScopeMs ?? {}) },
      relationTtlMs: { ...DEFAULT_WORLD_DECAY.relationTtlMs, ...(decay.relationTtlMs ?? {}) },
    };
  }

  backendName(): string { return this.store.backendName(); }

  /** Read-only persistence probe. Empty state is healthy; null is a backend/corruption failure. */
  async isHealthy(uid: string): Promise<boolean> {
    if (!uid || uid.includes("/") || uid.length > 128) return false;
    try { return (await this.store.load(uid)) !== null; } catch { return false; }
  }

  private validate(input: WorldAssertionInput): string | null {
    if (!input.uid || input.uid.includes("/") || input.uid.length > 128) return "invalid uid";
    if (!input.entity?.id || !input.entity.label || input.entity.id.length > WORLD_MODEL_LIMITS.entityChars || input.entity.label.length > WORLD_MODEL_LIMITS.entityChars) return "invalid entity";
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(input.relation)) return "invalid relation";
    if (!["environment", "project", "session", "user"].includes(input.scope)) return "invalid scope";
    if (!["application", "file", "folder", "device", "project", "session", "user", "resource", "other"].includes(input.entity.type)) return "invalid entity type";
    if (input.value !== null && !["string", "number", "boolean"].includes(typeof input.value)) return "invalid scalar value";
    if (typeof input.value === "string" && input.value.length > WORLD_MODEL_LIMITS.valueChars) return "value too long";
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) return "invalid confidence";
    const privacyText = `${input.entity.label} ${input.relation} ${String(input.value)}`;
    if (isSensitiveTopic(privacyText)) return "privacy-sensitive assertion refused";
    if (/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/i.test(privacyText)) return "credential-like assertion refused";
    if ((input.source.kind === "model" || input.source.kind === "memory") && isAuthoritativeVerification(input.verification)) return "untrusted source cannot be authoritative";
    return null;
  }

  private ttl(input: WorldAssertionInput): number | null {
    if (input.ttlMs !== undefined) return input.ttlMs;
    if (Object.prototype.hasOwnProperty.call(this.decay.relationTtlMs, input.relation)) return this.decay.relationTtlMs[input.relation];
    return this.decay.defaultByScopeMs[input.scope];
  }

  async record(input: WorldAssertionInput): Promise<WorldMutationResult> {
    const invalid = this.validate(input);
    if (invalid) return { accepted: false, reason: invalid };
    const now = Date.now();
    const observedAt = Number.isFinite(input.observedAt) ? Math.min(input.observedAt!, now + 60_000) : now;
    const authoritative = isAuthoritativeVerification(input.verification);
    const ttl = this.ttl(input);
    const assertion: WorldAssertion = {
      id: randomUUID(), uid: input.uid,
      entity: { ...input.entity, id: clip(input.entity.id, WORLD_MODEL_LIMITS.entityChars), label: clip(input.entity.label, WORLD_MODEL_LIMITS.entityChars) },
      relation: input.relation, value: input.value, scope: input.scope,
      status: authoritative ? "active" : "unverified", verification: input.verification,
      confidence: input.confidence, validFrom: observedAt, validTo: null,
      observedAt, recordedAt: now, expiresAt: ttl === null ? null : observedAt + Math.max(0, ttl),
      source: { kind: input.source.kind, id: sanitizeEvidence(input.source.id).slice(0, 160) },
      provenance: [{ sourceKind: input.source.kind, sourceId: sanitizeEvidence(input.source.id).slice(0, 160), observedAt, recordedAt: now, verification: input.verification, confidence: input.confidence, evidence: sanitizeEvidence(input.source.evidence ?? "", WORLD_MODEL_LIMITS.evidenceChars) }],
      supersedes: [], contradicts: [],
    };

    const result = await this.store.transact<WorldMutationResult>(input.uid, (current) => {
      const original = clone(current);
      const sameSlot = current.filter((item) => slot(item) === slot(assertion) && item.status !== "retracted");
      for (const item of sameSlot) {
        if (item.status === "active" && item.expiresAt !== null && item.expiresAt <= observedAt) {
          item.status = "stale";
          item.validTo = item.validTo ?? item.expiresAt;
        }
      }
      const match = sameSlot.find((item) => sameValue(item.value, assertion.value) && (item.status === "active" || item.status === "unverified"));
      if (match) {
        match.provenance = [...match.provenance, ...assertion.provenance].slice(-WORLD_MODEL_LIMITS.provenancePerAssertion);
        match.confidence = Math.max(match.confidence, assertion.confidence);
        if (authoritative && observedAt >= match.observedAt) {
          match.observedAt = observedAt; match.validFrom = Math.min(match.validFrom, observedAt);
          match.expiresAt = assertion.expiresAt; match.verification = assertion.verification;
          match.status = "active"; match.source = assertion.source;
        }
        return { assertions: current, result: { accepted: true, reason: "matching assertion reinforced", resolution: "reinforced", assertion: clone(match) } satisfies WorldMutationResult };
      }

      if (!authoritative) {
        current.push(assertion);
        const bounded = this.bound(current);
        if (!bounded) return { assertions: original, result: { accepted: false, reason: "world-state capacity reached; evidence was not deleted" } satisfies WorldMutationResult };
        return { assertions: bounded, result: { accepted: true, reason: "evidence retained but not authoritative", resolution: "recorded_unverified", assertion: clone(assertion) } satisfies WorldMutationResult };
      }

      let superseded = false;
      for (const prior of sameSlot.filter((item) => item.status === "active" && isAuthoritativeVerification(item.verification))) {
        prior.contradicts = [...new Set([...prior.contradicts, assertion.id])].slice(-WORLD_MODEL_LIMITS.linksPerAssertion);
        assertion.contradicts.push(prior.id);
        const newWins = reliability(assertion.source.kind, assertion.verification) > reliability(prior.source.kind, prior.verification)
          || (reliability(assertion.source.kind, assertion.verification) === reliability(prior.source.kind, prior.verification) && observedAt >= prior.observedAt);
        if (newWins) {
          prior.status = "superseded"; prior.validTo = observedAt;
          assertion.supersedes.push(prior.id); superseded = true;
        } else {
          assertion.status = "contradicted"; assertion.validTo = observedAt;
        }
      }
      assertion.contradicts = [...new Set(assertion.contradicts)].slice(-WORLD_MODEL_LIMITS.linksPerAssertion);
      assertion.supersedes = [...new Set(assertion.supersedes)].slice(-WORLD_MODEL_LIMITS.linksPerAssertion);
      current.push(assertion);
      const bounded = this.bound(current);
      if (!bounded) return { assertions: original, result: { accepted: false, reason: "world-state capacity reached; evidence was not deleted" } satisfies WorldMutationResult };
      return { assertions: bounded, result: { accepted: true, reason: assertion.status === "active" ? "authoritative assertion recorded" : "contradictory evidence retained", resolution: assertion.status === "active" && superseded ? "superseded" : assertion.status === "active" ? "added" : "conflicted", assertion: clone(assertion) } satisfies WorldMutationResult };
    });
    return result ?? { accepted: false, reason: "world-state persistence unavailable" };
  }

  private bound(items: WorldAssertion[]): WorldAssertion[] | null {
    if (items.length <= WORLD_MODEL_LIMITS.assertionsPerUser) return items;
    const removable = [...items].filter((x) => ["retracted", "stale", "unverified"].includes(x.status)).sort((a, b) => a.recordedAt - b.recordedAt);
    const remove = new Set(removable.slice(0, items.length - WORLD_MODEL_LIMITS.assertionsPerUser).map((x) => x.id));
    const bounded = items.filter((x) => !remove.has(x.id));
    return bounded.length <= WORLD_MODEL_LIMITS.assertionsPerUser ? bounded : null;
  }

  private async loaded(uid: string): Promise<WorldAssertion[]> { return (await this.store.load(uid)) ?? []; }
  private filter(items: WorldAssertion[], q: WorldQuery = {}): WorldAssertion[] {
    let out = items.filter((x) => (!q.entityId || x.entity.id === q.entityId) && (!q.relation || x.relation === q.relation) && (!q.scope || x.scope === q.scope) && (q.includeUnverified || isAuthoritativeVerification(x.verification)));
    if (q.since !== undefined) out = out.filter((x) => x.observedAt >= q.since!);
    return out.sort((a, b) => b.observedAt - a.observedAt).slice(0, Math.min(q.limit ?? WORLD_MODEL_LIMITS.queryResults, WORLD_MODEL_LIMITS.queryResults));
  }

  async current(uid: string, q: WorldQuery = {}): Promise<WorldAssertion[]> {
    const at = q.at ?? Date.now();
    return this.filter((await this.loaded(uid)).filter((x) => x.status === "active" && x.validFrom <= at && (x.validTo === null || x.validTo > at) && (x.expiresAt === null || x.expiresAt > at)), q);
  }
  async atTime(uid: string, at: number, q: WorldQuery = {}): Promise<WorldAssertion[]> {
    return this.filter((await this.loaded(uid)).filter((x) => isAuthoritativeVerification(x.verification) && x.validFrom <= at && (x.validTo === null || x.validTo > at) && (x.expiresAt === null || x.expiresAt > at)), { ...q, at });
  }
  async history(uid: string, q: WorldQuery = {}): Promise<WorldAssertion[]> { return this.filter(await this.loaded(uid), { ...q, includeUnverified: q.includeUnverified ?? true }); }
  async recentChanges(uid: string, since: number, limit = 20): Promise<WorldAssertion[]> { return this.history(uid, { since, limit, includeUnverified: true }); }

  async retrieveRelevant(uid: string, query: string, limit: number = WORLD_MODEL_LIMITS.queryResults): Promise<WorldAssertion[]> {
    const q = tokens(query);
    const now = Date.now();
    // Rank over the bounded per-user corpus, not merely the newest page.
    // Otherwise an older but highly relevant assertion can never be selected.
    const current = (await this.loaded(uid)).filter((x) =>
      x.status === "active" && isAuthoritativeVerification(x.verification)
      && x.validFrom <= now && (x.validTo === null || x.validTo > now)
      && (x.expiresAt === null || x.expiresAt > now));
    return current.map((a) => {
      const hay = tokens(`${a.entity.label} ${a.entity.id} ${a.relation} ${String(a.value)} ${a.scope}`);
      let score = a.confidence;
      for (const token of q) if (hay.has(token)) score += 2;
      return { a, score };
    }).sort((a, b) => b.score - a.score || b.a.observedAt - a.a.observedAt)
      .slice(0, Math.min(limit, WORLD_MODEL_LIMITS.queryResults)).map((x) => x.a);
  }

  async sweepStale(uid: string, at = Date.now()): Promise<number> {
    return (await this.store.transact(uid, (current) => {
      let changed = 0;
      for (const item of current) if (item.status === "active" && item.expiresAt !== null && item.expiresAt <= at) { item.status = "stale"; item.validTo = item.validTo ?? item.expiresAt; changed++; }
      return { assertions: current, result: changed };
    })) ?? 0;
  }

  async recordVerifiedObservation(uid: string, step: PlanStep, observation: Observation): Promise<boolean> {
    const input = verifiedObservationToAssertion(uid, step, observation);
    if (!input) return false;
    return (await this.record(input)).accepted;
  }

  async getGoalEvidence(uid: string, goalText: string, limit: number = 5): Promise<WorldAssertion[]> {
    const wanted = tokens(goalText);
    return (await this.retrieveRelevant(uid, goalText, WORLD_MODEL_LIMITS.queryResults))
      .filter((x) => {
        if (x.verification !== "VERIFIED") return false;
        const available = tokens(`${x.entity.id} ${x.entity.label} ${x.relation} ${String(x.value)}`);
        return [...wanted].some((token) => available.has(token));
      })
      .slice(0, Math.min(limit, 5));
  }

  /** Only explicit, confirmed user PREFERS/IDENTITY assertions may feed UserModel. */
  toUserModelOutcome(assertion: WorldAssertion): { kind: "preference" | "identity"; text: string; memoryId: string; confidence: number; source: "explicit"; isCorrection: boolean } | null {
    if (assertion.scope !== "user" || assertion.verification !== "USER_CONFIRMED" || !["user_explicit", "user_correction"].includes(assertion.source.kind)) return null;
    if (assertion.relation !== "PREFERS" && assertion.relation !== "IDENTITY") return null;
    return {
      kind: assertion.relation === "PREFERS" ? "preference" : "identity",
      text: `${assertion.entity.label} ${String(assertion.value)}`.slice(0, 500),
      memoryId: assertion.id,
      confidence: assertion.confidence,
      source: "explicit",
      isCorrection: assertion.source.kind === "user_correction",
    };
  }
}
