# LOHZ Phase 39 Architecture

Status: `IMPLEMENTED` and locally `VERIFIED` on 2026-09-01.

## Purpose

Phase 39 adds a deterministic, user-scoped learning-from-experience layer over the existing Phase 36 execution experience store. It does not add a second planner, memory system, world model, self-model, authorization system, or executable skill format.

The layer answers bounded engineering questions about completed work:

- what was attempted;
- what durable execution and observation records say happened;
- whether the outcome was success, failure, or partial;
- whether recovery or replanning occurred;
- which data-only lessons are supported by that evidence.

It does not claim consciousness, autonomous self-improvement, or unrestricted self-modification.

## Canonical data flow

```text
authenticated request
  -> normal planner / authorization / execution
  -> durable ExecutionRecord + Observation + Plan
  -> ExperienceBuilder
  -> ExperienceRecord in the existing LearningStore
  -> ExperienceReflectionService (deterministic, zero model calls)
  -> ExperienceReflection + LessonRecord[]
```

The reflection stage runs only after the experience has been durably accepted. Awaiting-confirmation and rejected/non-terminal records are stored as skipped reflections and generate no lesson.

## Experience representation

Phase 39 reuses `ExperienceRecord` rather than creating a competing record type.

| Requested concept | Canonical LOHZ field |
| --- | --- |
| experienceId | `id` |
| userId | `uid` |
| taskType | `context.signature` |
| planId | `planId` |
| outcome | `outcome` and `success` |
| observations | `source.observationIds` plus per-step `verification` |
| errors | `failures` and per-step `failureCode` |
| recoveryAttempts | `recovery` and `replans` |
| lessons | referenced by `ExperienceReflection.lessonIds` |
| timestamp | `createdAt` |

This keeps execution evidence immutable. Reflections and lessons reference experience IDs instead of rewriting the source record.

## Reflection representation

`ExperienceReflection` contains:

- owner UID and source experience ID;
- task signature and terminal outcome;
- completed/skipped status;
- bounded lesson IDs;
- bounded rejection reason codes;
- generation timestamp;
- `deterministic: true` and `modelCallsUsed: 0`.

One reflection is accepted per `(uid, experienceId)`. Repeated or post-restart processing returns the stored reflection and does not reinforce lessons twice.

## Lesson representation

`LessonRecord` contains:

- `lessonId`, `uid`, type, normalized topic, statement, and polarity;
- environment/signature context;
- source experience IDs and evidence count;
- heuristic confidence explicitly labelled `confidenceKind: "heuristic"`;
- contradiction links and lifecycle status;
- created, updated, reinforced, and expiry timestamps;
- optimistic revision;
- fixed safety metadata declaring data-only, non-executable, policy-immutable, and no authorization effect.

Supported lesson types:

- `procedural`;
- `tool_reliability`;
- `user_preference`;
- `planning`;
- `recovery`;
- `contextual`.

## Deduplication, contradiction, and decay

Lesson identity is deterministic over owner, type, normalized topic, polarity, and task signature.

- A repeated experience ID is idempotent.
- A new experience supporting the same lesson reinforces the existing record.
- Opposite positive/negative lessons for the same topic and context are both retained and cross-linked as `contradicted`.
- No contradictory record is silently deleted.
- Type-specific expiry marks records `stale` while retaining provenance.

Default TTLs are 30 days for tool reliability, 60 days for contextual evidence, 90 days for planning/recovery, 180 days for procedural evidence, and 365 days for explicit user-preference evidence.

## Learning safety boundary

Lessons are evidence only. No Phase 39 component can:

- change authentication or authorization;
- change confirmation or tool-risk policy;
- read or write credentials;
- grant permissions;
- execute tools or code;
- promote a skill;
- update UserModel, Memory, World Model, or self-model;
- become prompt instructions.

Generated lesson statements use bounded structured fields. Explicit correction text is accepted as preference evidence only when it matches a narrow first-person preference form and passes the unsafe-content fence. Prompt-injection, policy-changing, credential, permission, and executable-command content is rejected before lesson creation.

## Layer separation

```text
Facts / semantic memory       MemoryStore and MemoryIntelligence
Preferences / user identity  UserModel and confirmed memory outcomes
Procedures / executable data Versioned SkillLibrary with human promotion
Lessons / evidence           Phase 39 LessonRecord
External environment         WorldModel assertions
LOHZ operational state       self-model / HealthEngine
```

The older conversational `ReflectionEngine`, in-memory `SelfEvaluationEngine`, and procedural-memory learning seam remain compatibility systems. Phase 39 does not read their output, does not reinterpret it as authority, and does not remove or deprecate them.

## Persistence and concurrency

All Phase 39 records use the existing `LearningStore` abstraction:

- `InMemoryLearningStore` for unit tests;
- `LocalLearningStore` for restart-safe local fallback;
- `FirestoreLearningStore` for server deployments.

Local writes share the existing per-UID serialized atomic-file update path. Firestore lesson writes use optimistic compare-and-set revisions. Source experience IDs make retries idempotent even when two servers race. Firestore Security Rules allow owner reads but reject client writes; authoritative writes remain server-mediated.

## Authenticated API surface

Read-only endpoints:

- `GET /api/learning/experiences`;
- `GET /api/learning/reflections`;
- `GET /api/learning/lessons`.

Explicit correction capture remains authenticated and bounded. There is no client endpoint that creates, edits, promotes, or executes lessons.

## Production limitations

- Lesson generation is deterministic and intentionally conservative; it does not perform causal diagnosis beyond recorded verification, failure, recovery, and replan evidence.
- Heuristic confidence is not a probability or reliability percentage.
- User-preference lessons require a narrow explicit first-person correction form and remain evidence; they do not update UserModel automatically.
- Firestore optimistic revisions prevent lost updates, but collection-size enforcement is strongest in local/in-memory stores; server generation remains bounded to the configured record limit.
- Legacy reflection/procedural-memory paths remain for compatibility and are not consolidated into Phase 39 without separate approval.
- No live provider call is part of reflection, and no live-provider E2E was needed for this deterministic phase.

