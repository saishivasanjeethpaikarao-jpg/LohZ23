# Phase 42 — Knowledge Gap, Curiosity & Information-Gain Engine (Architecture)

Status: **EXPERIMENTAL research layer.** Read: it records gaps and ranks
sources. It never executes a tool, never speaks, never bypasses
authorization, and makes **no AGI claim**.

---

## 1. Purpose

LOHZ previously answered "I don't know" at the router level and stopped.
Phase 42 structures that moment as data:

> "I am missing information X. Getting X via source S would reduce my
> uncertainty by the most, safely."

Two outcomes are now possible instead of one:
- if a safe source exists → recommend it (with full provenance);
- if none exists → **withhold** (declared insufficient — this is the
  "action avoidance" path, and it is a first-class outcome, not silence).

## 2. KnowledgeGap schema

`src/lib/curiosity/types.ts` (bounded, per-user):

```ts
KnowledgeGap {
  gapId: string;               // deterministic hash of (uid, missingInformation)
  question: string;            // ≤240 chars, template-generated only
  missingInformation: string;  // ≤200 chars, the concrete missing fact
  importance: number;          // 0..1
  uncertainty: number;         // 0..1, decreases only via evidence paths
  possibleSources: InfoSourceKind[];  // ≤6, closed vocabulary
  status: "open" | "probing" | "resolved" | "stale" | "dismissed";
  source: GapSourceKind;
  openedAt / updatedAt / expiresAt: number;
  probes: number;
  resolution: { kind, note } | null;
}
```

Gap kinds: `low_confidence_intent`, `missing_entity`, `missing_context`,
`unverified_outcome`, `stale_knowledge`, `explicit_unknown`.

## 3. Detection (deterministic, post-route)

`detection.ts: detectGap()` maps a finished route outcome to ≤1 gap seed:

| Signal | Gap kind | Default sources |
|---|---|---|
| explicit "I don't know / not sure" | explicit_unknown | memory → state → probe → ask |
| `staleReference` present | stale_knowledge | state → probe |
| verification FAILED / INCONCLUSIVE | unverified_outcome | **safe_probe first**, then ask |
| clarify loop / confidence < 0.6 | low_confidence_intent | ask_user only |
| otherwise | (no gap) | — |

No model is consulted for detection.

## 4. Information-gain ranking (`infoGain.ts`)

score = expectedGain × safetyFactor − λ·cost (λ = 0.6), threshold 0.30.

| Source | base gain | cost | hard rules |
|---|---|---|---|
| ask_user | 0.85 | 0.45 | cooldown 10 min; ×0.25 gain when a free source has the answer |
| use_memory | 0.60 | 0.02 | ÷~6 when no plausible memory |
| inspect_state | 0.55 | 0.03 | ÷~6 when no current assertion |
| safe_probe | 0.80 | 0.10 | blocked (safetyFactor=0) when probe wouldn't be LOW risk |
| inspect_file | 0.55 | 0.30 | safetyFactor=0 (MEDIUM risk — confirmation lives elsewhere) |
| trusted_query | 0.45 | 0.40 | **disabled by default** (safetyFactor=0) |

The "never pester" rule is the free-source discount: when memory or world
state can answer, asking the user falls below the alternative — and below
threshold when appropriate, yielding `withhold`.

## 5. Service (`service.ts`)

`CuriosityService` lifecycle:

- `captureRouteOutcome(uid, input)` → seed → dedupe (same gap: reinforce
  importance +0.05, refresh expiry; never duplicate) → capacity evict
  oldest/lowest-importance open gap (as `stale`, never deleted).
- `recommend(uid, gapId)` → ranked plan + chosen action; one interaction
  logged; gap moves open → probing.
- Resolution paths with different strength semantics:
  - `resolveWithEvidence` (verified observation): uncertainty → ~0.
  - `resolveWithUserAnswer`: full close only for low-stakes gaps;
    high-stakes (importance ≥ 0.8) drops to ≥0.2 — remains insufficient.
  - `applyMemoryHit`: partial reduction only; can never fully resolve
    unless already low-importance and near-certain. This is what keeps
    `incorrectAssumptions` at zero in the eval harness.
- `dismiss(uid, gapId)` → terminal; `sufficiency(uid, gapId)` is an
  honest "can we act?" predicate exported for callers/eval.

**Structural safety:** the service holds no tool runner, gateway, or
emitter. The only expressive outputs are gap rows + ranked proposals.

## 6. Persistence

- `CuriosityStore` seam with `InMemoryCuriosityStore` and
  `LocalCuriosityStore` (per-user atomic JSON under `data/phase42-curiosity/`,
  fail-closed corrupt handling, same pattern as Phase 36's durable store).
- Interactions (questions asked / hints / withholds) are a bounded ring
  per user so ask-cooldowns survive restarts.

## 7. Server surface (read-only + dismiss)

- Gap capture is attached at `POST /api/route` completion, fire-and-forget —
  it can never change a response.
- Routes: `GET /api/curiosity/gaps`, `POST /api/curiosity/gaps/:id/dismiss`.
  Both behind the existing UID auth. No route executes probes; any such
  execution remains a normal planner/executor/policy matter.

## 8. Offline evaluation harness (`evaluation.ts`)

Scripted scenarios with stub providers + oracle expectations. Metrics:

| Metric | Definition | Corpus expectation |
|---|---|---|
| unnecessaryQuestions | asked when memory/world could answer | **0** |
| usefulQuestions | user-answered, truthful, resolved | ≥ 1 |
| uncertaintyReduction | mean uncertainty drop across resolved | > 0.5 |
| incorrectAssumptions | resolved via WRONG memory-only path | **0** |
| actionAvoidance | `withhold` chosen under insufficient info | ≥ 1 |

The corpus exercises the full action lattice: ask-when-empty,
memory-first, probe-before-ask, state-first, withhold-when-unsafe,
wrong-memory protection.

## 9. Explicit non-goals

- No autonomous probing: recommendations are data; execution would flow
  through the ordinary plan/authorize/observe path only if a caller chose.
- No learning-to-ask-more; ranking weights are fixed constants.
- No external network querying (`trusted_query` is disabled by default).
- No claims of understanding, curiosity as cognition, or generality.
