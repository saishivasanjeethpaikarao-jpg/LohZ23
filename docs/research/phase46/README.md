# LOHZ Phase 46 — Unified Cognitive Operating System

## Scope

This phase defines an authoritative architectural model that unifies the assistant's perception, context, memory, reasoning, execution, verification, reflection, learning, and safety boundaries without allowing any subsystem to become a second authority.

The goal is not AGI by declaration. The goal is an integrated operating model: every action passes through the same state, evidence, authorization, and outcome pipeline.

## Core principle

There is one authoritative runtime state:

- `UnifiedCognitiveState`
- `SituationFrame`
- `ExecutionRecord`
- `VerificationResult`
- `LearningProposal`

No subsystem may silently override truth, memory, intent, or execution policy. The orchestrator owns the lifecycle, while subsystems contribute observations and partial states.

## Required pipeline

```text
INPUT
 ↓
Perception
 ↓
Participant Context
 ↓
SituationFrame
 ↓
Memory Retrieval
 ↓
World Model
 ↓
Self Model
 ↓
Goal State
 ↓
Reasoning
 ↓
Planning
 ↓
Skill Selection
 ↓
Authorization
 ↓
Execution
 ↓
Observation
 ↓
Verification
 ↓
Reflection
 ↓
Learning Proposal
 ↓
Memory / World Model / Skill Update
 ↓
Response
```

## Failure contract

Each stage may return one of:

- `SUCCESS`
- `FAILED`
- `UNCERTAIN`
- `NEEDS_USER`
- `BLOCKED`

The system may not convert uncertainty into success. If the evidence is weak, the stage must either return `UNCERTAIN` or `NEEDS_USER` and require the next explicit decision gate.

## Non-goals

This phase does not authorize:

- direct autonomous production mutation without the safe change pipeline;
- hidden second authorities for memory, planning, or execution;
- silent state drift between models and runtime;
- bypass of verification or reflection after action.

## Files in this phase

- `PHASE_46_ARCHITECTURE.md` — authoritative architecture and state design
- `PHASE_46_INTEGRATION_TEST_SUITE.md` — the end-to-end scenario suite
- `PHASE_46_AUDIT_REPORT.md` — architecture audit and compliance review

## Status

Phase 46 is an isolated architectural definition and integration design package. It is documentation and integration specification, not a mechanism that bypasses the existing controlled production pipeline.
