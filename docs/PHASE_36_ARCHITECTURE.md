# LOHZ Phase 36 Learning Architecture

Date: 2026-08-31

## Scope

Phase 36 adds bounded learning from verified execution experience. It does not add unrestricted self-modification, executable learned code, a second planner, or a second authorization system.

## Lifecycle

```text
authenticated execution
        |
        v
plan + execution + observations + recovery/replan evidence
        |
        v
bounded ExperienceRecord (user-owned, untrusted data)
        |
        v
exact repeated verified pattern (minimum 3)
        |
        v
immutable candidate SkillVersion
        |
        v
schema/tool/security validation
        |
        v
deterministic source replay comparison
        |
        v
pending human approval
        |
        v
promoted declarative skill data
        |
        v
existing PlanExecutionEngine -> authorization -> confirmation
        -> tool policy -> execution -> observation -> recovery
```

Promotion never occurs automatically. Validation, replay, an approval request, and an authenticated matching approval are distinct state transitions.

## Experience records

`ExperienceBuilder` joins the existing user-owned plan, execution, and observation stores. A record contains the objective, bounded environment/signature context, plan version, ordered steps, outcomes, failures, recovery, replan lineage, verification, corrections, provenance IDs, and timestamps.

Tool completion is not considered verified without a matching persisted verified observation. Inconclusive evidence cannot form a candidate. Credential-like argument keys are removed, text and arrays are bounded, and all captured content remains untrusted data.

## Skill data model

A `SkillVersion` contains:

- owner UID, stable skill ID, and immutable integer version;
- name, description, exact trigger signature, and required environment/tags;
- a bounded declarative step DAG of known tool names and JSON arguments;
- maximum risk, involved tools, confirmation requirement, and `policyMutable: false`;
- source experience IDs and minimum-sample-aware metrics;
- validation, replay, approval, creation, and last-verification metadata;
- one lifecycle status: candidate, validated, replay-verified, pending approval, promoted, unreliable, rejected, or retired.

Step graphs cannot contain code or scripts. They are capped at 20 steps and validated for shape, tool catalog membership, retry/timeout bounds, dependencies, cycles, risk consistency, source ownership, source verification, and immutable security-domain language.

## Execution boundary

`SkillExecutor` accepts only an authenticated UID and a promoted version owned by that UID. It converts skill data into a normal `Plan`, persists it, and delegates to the existing observed `PlanExecutionEngine`.

A skill grants zero authority. Without explicit confirmation, normal execution policy can return `REQUIRES_CONFIRMATION`. Authentication, authorization, tool risk, confirmation, persistence, idempotency, observation, recovery, and user ownership remain in the existing execution path.

## Reliability and revision

Tool reliability is aggregated by owner, tool, environment, context signature, and failure kind. Skill reliability is aggregated by owner, skill version, and environment. Rates remain `null` below five samples.

Three consecutive verified failures mark a version unreliable and remove it from selection. Production data is not silently edited. Revision creates a new candidate version; rollback also creates a new explicitly approved version and retains prior history.

Explicit user corrections create immutable negative experience evidence. They do not mutate their source and do not falsely count as tool failures.

## Persistence and concurrency

- Local deployments use atomic, restart-safe JSON persistence under `data/phase36-learning`.
- Firestore deployments use user-namespaced experiences, skill versions, version heads, skill reliability, and tool reliability.
- Firestore version heads use transactions for compare-and-set version progression.
- Per-user learning queues serialize reliability and ingestion updates without blocking other users.
- Firestore client rules allow owner reads but deny client writes; trusted server routes perform transitions.

## Authenticated API

All endpoints are below the existing `/api` authentication middleware:

- capture/list experiences and record explicit corrections;
- detect/list/select candidate or promoted skills;
- validate, replay, request approval, approve, reject, revise, and rollback versions;
- execute a promoted version through the normal observed execution engine.

## Non-capabilities

- No model-generated executable code.
- No silent promotion or policy mutation.
- No modification of authentication, authorization, credential handling, dangerous-tool restrictions, or ownership rules.
- No semantic/generalized induction beyond exact deterministic signatures.
- No automatic natural-language skill invocation in CognitiveRouter.
- No claim of general self-improvement.

