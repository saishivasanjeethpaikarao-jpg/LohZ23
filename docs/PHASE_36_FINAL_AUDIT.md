# LOHZ Phase 36 Final Audit — Learning and Skill Acquisition

Date: 2026-08-31

## Verdict

`PHASE 36 COMPLETE`

LOHZ now has a bounded, user-scoped mechanism for learning reusable declarative procedures from repeated verified experience. Skills remain data and cannot rewrite or bypass security policy.

## Prerequisite and baseline

The Phase 35 implementation and audit were present before this work, including the world model, memory layers, verified-observation seam, user isolation, and full regression coverage. The verified pre-Phase-36 baseline was 63 test files and 883 tests passing.

The earlier multi-person-conversation work that used the same phase number was preserved separately in `PHASE_36_CONVERSATION_FINAL_AUDIT.md` and `PHASE_36_CONVERSATION_ARCHITECTURE.md`; it was not overwritten or misrepresented as this learning phase.

## Implemented learning architecture

The production flow is:

```text
existing execution records + plan + observation + recovery/replan
  -> bounded ExperienceRecord
  -> repeated verified signature (at least 3)
  -> immutable candidate SkillVersion
  -> validation
  -> deterministic replay comparison
  -> authenticated human approval
  -> promoted skill data
  -> existing observed execution engine and all normal safety gates
```

Automatic capture is wired after terminal Tier 0 authorized tool executions and Tier 3 planned executions. Existing execution truth is never changed if learning capture fails. Existing records can also be captured through an authenticated API.

## Experience data

Experience records include objective, environment/signature context, plan/version, step graph, arguments, outcomes, attempts, failures, recovery, replans, verification, user corrections, source execution/observation IDs, and creation time.

Evidence rules:

- only user-owned plan, execution, and observation records are joined;
- a tool step requires a persisted verified observation to be `VERIFIED`;
- missing evidence remains `INCONCLUSIVE` and cannot create a candidate;
- credential-like argument keys are stripped;
- text, arrays, record counts, and step counts are bounded;
- captured text is always untrusted data, never instructions.

## Lesson and candidate behavior

Candidate detection groups exact verified experience signatures and requires at least three successful samples. It creates at most one initial candidate for that signature. It does not validate, replay, approve, or promote automatically.

The implementation deliberately uses deterministic exact-pattern detection rather than an AI model or embeddings. This is safer and incurs no provider-credit cost, but it limits generalization.

## Versioned SkillLibrary

Each immutable skill version stores the required name, description, trigger/signature, required context, declarative step graph, risk profile, source experiences, success/failure counts and rates, version, creation time, and last verified time. It additionally stores owner UID, validation, replay, approval, status, and replacement lineage.

Library limits are 500 experiences per user, 100 skills per user, 20 versions per skill, 20 steps per version, and 50 source experiences per version.

## Promotion policy

The enforced lifecycle is candidate -> validated -> replay verified -> pending approval -> promoted. Promotion requires:

- valid bounded acyclic step data;
- only tools in the current catalog;
- at least three owned, verified, consistent source experiences;
- stable replay fingerprints, including arguments, dependencies, and risk;
- no critical-risk learned procedure;
- no policy-mutation or executable-code fields;
- an authenticated UID matching the owner;
- an exact pending approval request ID and `approved: true`.

Rejection is explicit. Revision creates a new candidate version. Rollback creates a new approved promoted version rather than mutating history.

## Security boundary

Learning is explicitly prohibited from modifying authentication, authorization, security policy, credential handling, dangerous-tool restrictions, confirmation rules, or user ownership.

A promoted skill grants no authority. `SkillExecutor` converts it into a normal existing `Plan` and invokes the existing `PlanExecutionEngine`. Normal authentication, authorization, risk policy, confirmation, durable execution, idempotency, tool execution, observation, recovery, and ownership checks remain mandatory.

Firestore learning collections are user-namespaced. Clients may read only their own records and cannot write experiences, promotion state, or reliability counters directly; trusted authenticated server routes mediate changes. Cross-user reads and execution fail closed.

## Reliability learning

Verified tool outcomes are aggregated by tool, environment, context signature, and failure type. Skill outcomes are tracked separately per version and environment. Success/failure rates remain `null` until five samples exist, preventing misleading tiny-sample percentages.

After three consecutive failures, a promoted skill is marked unreliable and excluded from selection. The step graph is not silently rewritten. Investigation and an explicit new candidate revision are required.

## User corrections

An explicit user correction creates a new immutable negative experience record linked to the source evidence. It cannot modify core policy from a single correction and does not mutate the successful source record. A correction about the intended outcome is not incorrectly counted as a tool reliability failure.

## Persistence and concurrency

- Restart-safe local storage uses atomic JSON replacement under `data/phase36-learning`.
- Firestore storage supports experiences, immutable versions, transactional version heads, skill reliability, and tool reliability.
- Per-user serialized updates prevent concurrent ingestion and reliability lost updates.
- Firestore operations fail closed on backend errors.
- State is isolated by authenticated UID in storage, services, routes, and execution.

## Authenticated production surface

Authenticated routes support experience list/capture/correction, candidate detection, selection, validation, replay, approval request/approval, rejection, explicit revision, explicit rollback, and promoted-skill execution.

The production server chooses Firestore when initialized and otherwise uses restart-safe local persistence. Both Tier 0 and Tier 3 terminal executions feed the same structured learning service.

## Tests

Dedicated learning tests cover:

- repeated experience threshold and candidate creation;
- validation, replay, rejection, approval, and promotion;
- unknown tools, malformed graphs, cycles, and prompt-injection/policy-change data;
- incompatible repeated arguments;
- versioning, explicit revision, rollback, and immutable production versions;
- unreliable skill detection and selection suppression;
- small-sample-safe tool and skill reliability;
- explicit user correction semantics;
- user isolation and concurrent candidate creation;
- concurrent ingestion without lost samples;
- local restart persistence;
- Firestore ownership, transactional versioning, and outage failure;
- normal skill execution, confirmation enforcement, observation verification, and cross-user rejection;
- authenticated server wiring and Firestore rules.

There are 23 dedicated tests in `src/lib/learning`, plus learning-specific Firestore rules/emulator coverage. The focused learning/rules suite passed 6 files and 26 tests.

Final command evidence:

| Gate | Result |
|---|---|
| `npm test` | PASS — 68 files, 907 tests |
| `npx tsc --noEmit` | PASS |
| `npm run lint` | PASS — repository lint script is `tsc --noEmit` |
| `npm run build` frontend | PASS — 2,119 modules transformed |
| `npm run build` server | PASS — `dist/server.cjs` bundled |

The Vite build emitted the existing advisory that the main minified JavaScript chunk exceeds 500 kB. It is a performance warning, not a build failure.

## Bugs found and fixed

1. Successful execution without an observation could have been learned as truth. Structured experience now remains inconclusive without persisted verification; regression tested.
2. Concurrent learning updates could lose reliability samples. Per-user serialization now protects ingestion/outcome updates; regression tested.
3. Firestore user IDs were initially encoded in a way that would not match the established rules namespace. The store now uses the authenticated UID path directly; ownership tests cover it.
4. Repeated experiences with the same coarse signature could hide different arguments. Replay now compares stable argument/dependency/risk fingerprints; regression tested.
5. Malformed revised steps could reach graph logic. Runtime shape and bounds validation now fail closed; tested through rejection cases.
6. Explicitly confirmed skill execution initially retained zero autonomy and could not resume through normal policy. Confirmation now raises only the minimum normal plan level; unconfirmed execution still blocks; both paths are tested.
7. A completed skill could be scored verified without authoritative observations. Reliability now requires matching persisted verified observations; regression tested.
8. Status transitions could have become an accidental mutation seam. Transition patches are whitelisted and cannot alter step graphs or security fields.
9. Awaiting-confirmation outcomes could have polluted terminal experience learning. Only completed or failed terminal authorized executions are auto-captured.
10. User corrections were initially capable of distorting tool reliability. Corrections are now stored as outcome evidence without counting the tool as failed; regression tested.

## Actual capability and limitations

### Implemented and verified

- Structured experience capture from real existing execution/observation stores.
- Deterministic repeated-pattern candidate generation.
- Versioned declarative SkillLibrary with local and Firestore persistence.
- Validation, replay comparison, human approval, promotion, rejection, revision, rollback, and reliability demotion.
- Execution through the existing authorization/confirmation/observation pipeline.
- User isolation, concurrency protection, restart persistence, and prompt-injection fencing.

### Limitations

- There is no review dashboard; lifecycle controls are authenticated APIs.
- Candidate discovery is exact-signature based and does not generalize semantically across differently phrased objectives.
- CognitiveRouter does not autonomously invoke a learned skill from free-form text. Selection is an explicit authenticated API operation, and execution names an exact promoted version.
- A client resuming a skill after confirmation should call the skill execution endpoint with the same request ID and `confirmed: true` so skill reliability is recorded in the same lifecycle.
- Firestore behavior is covered by repository/emulator-oriented tests, not a live deployed Firebase project in this run.
- This system stores and validates lessons/procedures. It is not general self-improvement and does not rewrite LOHZ source code or policy.

## Files created

- `src/lib/learning/types.ts`
- `src/lib/learning/store.ts`
- `src/lib/learning/experienceBuilder.ts`
- `src/lib/learning/policy.ts`
- `src/lib/learning/service.ts`
- `src/lib/learning/executor.ts`
- `src/lib/learning/durableStore.ts`
- `src/lib/learning/firestoreStore.ts`
- `src/lib/learning/index.ts`
- five dedicated learning test files
- `docs/PHASE_36_ARCHITECTURE.md`
- `docs/PHASE_36_FINAL_AUDIT.md`

## Files materially integrated

- `server.ts`
- `src/lib/integration/authorizedToolExecutor.ts`
- `firestore.rules`
- `src/lib/firestoreRules.test.ts`
- `src/lib/persistence/firestoreEmulator.test.ts`

## Final statement

Phase 36 provides real, bounded skill acquisition from verified experience while retaining all normal security and execution authorities. It does not silently self-modify and does not make an AGI or unrestricted self-improvement claim.

`PHASE 36 COMPLETE`

