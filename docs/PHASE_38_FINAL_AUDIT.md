# LOHZ Phase 38 Final Audit — Skill Acquisition & Versioned Skill Library

Date: 2026-09-01

## Verdict

`PHASE 38 COMPLETE`

The mandated skill-library schema, human-gated activation, planner
selection, and drift-based versioning are implemented against the
existing Phase-36 acquisition pipeline — no duplicate subsystems, no
second store, no new cognitive architecture.

## What was verified vs. what existed

A large share of the acquisition pipeline already existed (Phase 36):
experience capture, candidate detection, validation, replay, approval,
promotion, revision, rollback, reliability tracking, cross-user isolation,
restart persistence, Firestore-backed store, and authenticated lifecycle
routes. Phase 38 reuses all of it. New in this phase:

1. **Public schema:** `SkillLibrary.get/list` returns the exact mandated
   shape (`skillId/name/description/version/inputSchema/planTemplate/
   riskProfile/ownerUserId/status/successCount/failureCount/createdAt/
   updatedAt`), mapped from the underlying immutable `SkillVersion`.
2. **Status vocabulary:** the mandated `candidate/verified/active/
   deprecated` set, extended with `degraded` (required by the versioning
   section of the spec) mapped from `unreliable`/`degraded` storage states.
3. **Planner selection:** `HierarchicalPlanner.skills.matchPlan` seam —
   consulted only when stage-1 decomposition cannot express the request
   (before any model call). Returns a normal plan which then flows through
   the same finalize/validate/policy/observation machinery.
4. **Registry-drift versioning:** per-tool registry fingerprints recorded
   at acquisition; `SkillLibrary.revalidateAgainstRegistry` marks
   drifted promoted skills `degraded` and queues exactly one `candidate`
   v2 per degraded version, preserving the original step graph.
5. **Declarative parameterization:** bounded `inputSchema` + strict
   `${placeholder}` whole-argument substitution, validated at candidate
   validation time and fail-closed at execution time.

## Mandated test battery — all present, all passing

| Mandated case | Where |
|---|---|
| repeated workflow detection | "detection requires repeated verified workflow (≥3)" + Phase-36 repeated candidate test |
| candidate generation | same; schema field assertions in "exposes the mandated Skill schema fields" |
| skill validation | "validates parameterized candidates" + "rejects a malicious inputSchema" |
| user ownership | "owner isolation: cannot approve/get/deprecate another user's skill" |
| versioning | "registry drift degrades … preserving the original graph" + "tool removal degrades the skill too" (tool_removed + tool_changed + queued v2 + idempotent re-sweep) |
| skill execution | "executes an active skill through the normal engine (verification + observation)" |
| authorization | "never bypasses confirmation on medium-risk skill" (REQUIRES_CONFIRMATION; runner untouched; confirmed path completes) + planner-seam policy test |
| failed skill | "repeatedly-failing active skill becomes degraded … without graph mutation" |
| deprecated skill | "deprecated skills are not selectable or executable" (+ mapping to `retired`) |
| malicious skill data | `__proto__` key, invalid type, over-capacity schema, type-mismatched default, empty/oversized enum, partial-placeholder smuggling, unknown inputs at execute |
| cross-user isolation | "u1 skills invisible to u2" (list/get/approve/deprecate) |
| restart persistence | LocalLearningStore reopen retains `degraded` status, `degradation` record, `updatedAt` ≥ `createdAt` |

Planner-seam suite also covers: provenance marker onto `plan.constraints`,
0-model-call source (`generatedBy: "deterministic"`), no-hijack of
stage-1-expressible objectives (seam never consulted), non-matching
objective → model stage fallback, seam-throw → graceful fallback,
environment mismatch, degraded/deprecated skills skipped.

## Command evidence

| Gate | Before (pre-Phase 38 tree) | After |
|---|---|---|
| `npm test` (`vitest run`) | 77 files / 985 tests (derived: excludes the 2 new Phase-38 files) | **79 files / 1006 tests, all passing** (measured) |
| `npx tsc --noEmit` | clean | **clean** |
| `npm run build` | clean | **clean** (`dist/server.cjs` 690 kB; pre-existing chunk-size advisory only) |

(Phase-38 additions: 14 library tests in `src/lib/skills/skills.test.ts` + 7 planner-selection tests in `src/lib/skills/selection.test.ts` = +21.)

## Bugs found and fixed during this phase

1. Partial placeholder strings (`"pre-${x}"`) and placeholders without any
   schema were silently accepted by `validateSkillCandidate`. Both are now
   hard-rejected at validation time, not just at materialization time.
2. `updatedAt` now bumps on every store transition patch (previously the
   field existed on reliability records only) and is preserved across the
   whitelisted store patches.
3. The revised-version store patch previously lost `inputSchema` context;
   `revise` now accepts an explicit `{ inputSchema }` override and
   re-captures per-tool fingerprints for the new step graph.
4. Skill-provenance plans executed through the planner seam did not feed
   reliability counters; `skill_source:<id>@v<v>` constraints are now
   parsed after Tier-3 execution and recorded into `recordSkillOutcome`,
   with idempotent replays excluded.

## Security statement (unchanged from prior phases, re-asserted)

A skill is data. Selection is not authorization. `policyMutable: false`
rejects policy-shaped content; approval requires an authenticated,
owner-matching UID plus a fresh approval request ID; inputs are
whitelisted scalars; verification is observation-backed; cross-user
access fails closed in library, store, and service layers.

## Limitations (honest)

- Token-overlap matching is precise but not semantic; rephrased
  objectives without enough shared trigger tokens fall back to the
  existing model stage (by design, zero model calls on skill hits).
- `inputSchema` only covers top-level string placeholders; nested
  structures remain verbatim from acquisition.
- Drift detection compares recorded fingerprints against the current
  registry surface only; behavioral changes inside a tool's body (path
  always logged by the registry's own code) are outside this fingerprint.
- `deprecated` mapping preserves rejected+retired states but the library
  view does not distinguish them — inspection should use the raw store.
- Firestore-backed skill library semantics reuse the Phase-36 emulator
  contract; production rules deployment remains an external operation.

`PHASE 38 COMPLETE`
