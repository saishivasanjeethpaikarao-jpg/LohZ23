# LOHZ Phase 42 Final Audit — Knowledge Gap, Curiosity & Information-Gain Engine

Date: 2026-09-02 — Experimental research phase.

## Verdict

`PHASE 42 COMPLETE` (as research engineering; no production behavioral claim, no AGI claim).

LOHZ can now represent, persist, and reason deterministically about
*what it does not know*, rank safe ways to close each gap, and refuse
action when no safe source exists.

## Files added

- `src/lib/curiosity/types.ts` — `KnowledgeGap` schema (with the mandated
  fields), closed gap/source vocabularies, limits.
- `src/lib/curiosity/detection.ts` — post-route outcome → gap-seed mapping (deterministic).
- `src/lib/curiosity/infoGain.ts` — expected-gain × safety − cost ranking + threshold.
- `src/lib/curiosity/store.ts` — persistence seam + in-memory store.
- `src/lib/curiosity/durableStore.ts` — restart-safe per-user JSON store.
- `src/lib/curiosity/service.ts` — lifecycle: dedupe/capacity, rec `probing`,
  evidence/user/memory resolution with strictly distinct strength,
  dismiss, expiry, honest `sufficiency()` predicate.
- `src/lib/curiosity/evaluation.ts` — offline metrics harness.
- `src/lib/curiosity/index.ts` — barrel.
- `src/lib/curiosity/curiosity.test.ts` (20 tests) + `evaluation.test.ts` (8 tests).

## Integration (minimal, read-only)

- `POST /api/route` captures gap signals after the pipeline settles
  (fire-and-forget; can never alter the response).
- `GET /api/curiosity/gaps`, `POST /api/curiosity/gaps/:gapId/dismiss`
  behind the existing UID auth.
- Providers wired: bounded memory lookup + current world-model assertion
  presence. Both are read-only and fail-closed to `false`.

## Safety invariants (enforced, tested)

- CuriosityService has **no executor, gateway, or speaker reference** —
  structurally incapable of "randomly doing things".
- `ask_user` is rate-limited by a persisted 10-minute cooldown ring and
  discounted when a free source has the answer.
- `inspect_file` never passes the gate here (MEDIUM risk stays upstream);
  `trusted_query` is disabled by default.
- High-importance gaps never fully resolve on unverified answers.
- Memory hits are strictly partial → `incorrectAssumptions = 0`.
- `withhold` is a first-class recommendation when sources are unsafe or
  too weak — this is the spec's "action avoidance".

## Test evidence

| Gate | Result |
|---|---|
| `vitest run` | **84 files / 1059 tests, all passing** (includes 28 new Phase-42 tests) |
| `tsc --noEmit` | clean |
| `npm run build` | clean (`dist/server.cjs` 737 kB; pre-existing chunk-size advisory only) |

Offline evaluation harness results (deterministic corpus of 8 scenarios):
- unnecessaryQuestions = 0
- usefulQuestions = 2
- uncertaintyReduction ≈ 0.82 (mean over resolved)
- incorrectAssumptions = 0
- actionAvoidance = 1 ("withhold-when-no-safe-source")

## Concurrency note (honest)

During this phase a parallel session added `src/lib/research/engine.ts`,
`unifiedLoop.ts` status fields, and `UnifiedCognitiveStatus` under
`cognitiveState.ts`. Phase 42 is independent of that work (no shared
files except the additive `cognitiveState.ts` type export), and both
streams pass all tests together as of this audit.

## Limitations

- Ranking weights are fixed constants, not learned.
- The workspace memory provider is a lexical token heuristic.
- The UI does not yet surface `withhold` to the user (the data exists).
- `trusted_query` and `inspect_file` are present as schema values only.
- The evaluation harness's oracle is scripted; it measures policy
  properties, not real-world phrasing diversity.

`PHASE 42 COMPLETE`
