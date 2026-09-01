# LOHZ Phase 35 Final Audit

Date: 2026-08-31

## Verdict

`PHASE 35 COMPLETE`

This phase adds a grounded, user-scoped world-state layer. It does not add consciousness, speculative simulation, a second planner, or a second cognitive architecture.

## Phase 34 gate

Phase 35 was started only after the Phase 34 stabilization implementation was present: authenticated cognitive entry, provider and live-transport safety checks, durable execution/observation persistence, distributed Firestore leases, restart recovery, Firebase rules coverage, and the five request-flow contracts. Phase 35 does not replace those authorities.

## Audit and reuse

The following existing components were inspected and retained:

- `MemoryStore`: durable, user-scoped memory persistence.
- `MemoryIntelligenceService`: deterministic extraction, deduplication, contradiction handling, and persistence.
- `UserModelEngine`: derived compact profile; not a world-state database.
- `TemporalService`: bounded event rings, absence/time context, restart persistence, and flushing.
- `AutonomousGoalManager`: goal authority, lifecycle, progress, evidence, and persistence.
- `CognitiveCore` and `SituationFrame`: the single cognitive decision/context path.
- `ObservationCoordinator`: authoritative verification seam after tool execution.
- `ExecutionRecord` and execution repositories: durable plan/execution lifecycle and distributed lease protection.
- Firestore user namespaces and rules.

No duplicate memory engine, goal manager, observer, planner, or cognitive core was created.

## Cognitive memory architecture

| Layer | Contents | Authority and lifetime |
|---|---|---|
| Working Memory | Current request and active task/step context | Request/session scoped and bounded; not durable by default |
| Episodic Memory | Timestamped events and verified outcomes | Durable MemoryStore/Temporal evidence with provenance |
| Semantic Memory | Stable facts supported by user statements or repeated evidence | Durable MemoryStore evidence; confidence and contradiction rules apply |
| Procedural Memory | Reusable procedures and verified recovery lessons | Durable MemoryStore records; never grants execution authority |
| World State | Time-aware assertions about the relevant environment | Separate WorldModelService; only verified or user-confirmed assertions are current truth |

The legacy `user_model` memory layer was removed. Identity and preference evidence is semantic memory; UserModel remains a derived profile. Legacy records normalize to `semantic` on the next memory pipeline write.

## World model schema

Each assertion contains:

```text
id, uid
entity { id, label, type }
relation
value (bounded scalar)
scope (environment | project | session | user)
status (active | superseded | contradicted | stale | retracted | unverified)
verification (VERIFIED | USER_CONFIRMED | UNVERIFIED | FAILED | INCONCLUSIVE)
confidence
validFrom, validTo, observedAt, recordedAt, expiresAt
source { kind, id }
provenance[]
supersedes[], contradicts[]
```

The per-user corpus is capped at 500 assertions. Query results are capped at 20, provenance entries at 8 per assertion, and relationship links at 12. At capacity, old stale/unverified evidence can be pruned; active evidence is never silently deleted to make room.

## Data flow and verification

```text
authorized tool action
  -> ObservationCoordinator observation
  -> persisted verification verdict
  -> VERIFIED only
  -> deterministic observation mapper
  -> WorldModelService transaction
  -> user-scoped assertion
```

`FAILED` and `INCONCLUSIVE` observations do not create current world truth. Model- or memory-sourced statements cannot claim authoritative verification. User corrections are accepted only through the authenticated server route and retain the contradicted assertion and both provenance chains.

Mapped tool observations currently cover application open/close/focus, volume changes, file/folder existence or readability, rename results, screenshots, clipboard-update state, and system-info observations. Clipboard contents are never retained in world state.

## Temporal behavior and contradictions

- Current-state queries filter by validity interval and expiry.
- Historical queries retain superseded, contradicted, stale, and unverified evidence.
- State-at-time queries evaluate `validFrom`, `validTo`, and `expiresAt`.
- Recent-change queries filter by observation timestamp.
- Configurable decay supports relation-specific and scope-specific TTLs.
- Re-observing a fact after expiry creates a new temporal episode rather than reviving the expired interval.
- Conflict resolution considers source reliability, verification, confidence/provenance, timestamp, and explicit user correction.
- Contradictory evidence is linked and retained, never silently overwritten.

Default fast-changing TTL examples are 10 minutes for output volume and 30 minutes for application status. Stable explicit `PREFERS` and `IDENTITY` relations do not expire by default.

## Persistence and concurrency

- Development fallback: atomic JSON files under `data/world-state`, with per-user in-process transaction queues and corrupt-file fail-closed behavior.
- Production: `users/{uid}/worldState/_root`, updated with Firestore transactions for multi-server concurrency.
- Firestore client rules allow the owner to read/delete their state but deny all client create/update operations, preventing forged `VERIFIED` provenance. Authenticated server routes mediate explicit user statements; Admin SDK writes remain user-scoped in code.
- Restart tests recreate both local and Firestore services and verify retained state.

## Cognitive integration

`ContextAssembler` now requests relevant assertions using the authenticated UID and raw request as the relevance query. Ranking operates across the entire bounded per-user corpus, then selects at most ten assertions for `SituationFrame`. Assertions remain structured through the frame and render only inside the existing `UNTRUSTED DATA` prompt fence.

No embeddings were introduced because deterministic token relevance is sufficient for the current bounded corpus. If embeddings are added later, UID and metadata filtering must occur before retrieval and the returned content must remain untrusted data.

## UserModel and goal integration

- Environment/project/session facts never automatically become user preferences or identity.
- Only authenticated, `USER_CONFIRMED`, user-scope `PREFERS` or `IDENTITY` assertions from explicit user input/correction may feed `UserModelEngine`.
- Verified world assertions can be attached to goal progress as `relatedWorldAssertionIds` after an already-authorized plan completes.
- World evidence does not create goals, change goal source/authority, or bypass existing goal lifecycle and autonomy policy.

## Security and privacy

- UID isolation is enforced by stores, transactions, authenticated routes, and Firestore rules.
- Values are bounded scalars; entities, relations, evidence, provenance, and links are bounded.
- Sensitive-profile topics and credential-looking assertions are refused.
- Credential-looking provenance/evidence is redacted.
- Retrieved assertion text is data, never instructions, and is prompt-fenced.
- Direct client forging of authoritative world state is denied.

## Bugs fixed with regression coverage

1. `MemoryIntelligenceService` previously treated a failed `MemoryStore.load()` (`null`) as an empty first-use store and could overwrite unknown existing state. It now fails closed and never calls save after a failed load.
2. Initial world relevance ranking selected only from the newest result page, which could hide older highly relevant facts. It now ranks across the entire bounded per-user corpus before applying the result limit.
3. Legacy `user_model` records duplicated the distinction between memory and derived UserModel. The memory layer was removed and legacy records normalize to semantic evidence.
4. Local world-state transaction queue tails were not removed after completion. Queue cleanup now compares the stored tail correctly.
5. The distributed lease emulator test incorrectly required the losing server to return `rejected`; a safe idempotent completed response is also valid. The regression now asserts the actual safety invariant: exactly one tool execution.

## Test evidence

- Full Vitest suite: 61 files, 856 tests passed.
- Phase 35 focused suites after final architecture changes: 7 files, 152 tests passed.
- World model suite: 11 tests passed.
- Firestore emulator: 7 tests passed, including rules, multi-user isolation, restart persistence, concurrent world updates, and distributed execution locking.
- TypeScript: `npm run lint` passed.
- Production bundle: `npm run build` passed.

Coverage includes assertion creation/reinforcement, contradictions, timestamps, temporal episodes, decay/staleness, provenance, verified versus unverified evidence, privacy rejection, cross-user isolation, concurrent updates, local and Firestore restart persistence, SituationFrame relevance, retrieval bounds, prompt-injection fencing, observation ingestion, UserModel separation, and goal evidence attachment.

## Limitations

- This is a grounded assertion store and query layer, not intelligence by itself.
- No inference engine, speculative simulation, autonomous discovery, or consciousness model exists.
- Only deterministic verified tool mappings listed above currently create observation-derived assertions.
- Token relevance is intentionally simple; embeddings are deferred until corpus/quality evidence justifies them.
- Firestore uses one bounded per-user world-state document. A future scale phase may shard it while preserving transactional contradiction rules.
- Expired assertions are excluded immediately at query time; persisting the `stale` status requires a decay sweep (available through the authenticated endpoint).
- Firebase rules were validated in the emulator during this phase; production deployment remains an operational release action, not an implementation claim.

`PHASE 35 COMPLETE`
