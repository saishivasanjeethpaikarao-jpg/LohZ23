# LOHZ Phase 37 Final Audit — Self-Model, Capability Awareness and Health Center

Date: 2026-09-01

## Verdict

`PHASE 37 COMPLETE`

LOHZ now maintains a persistent, user-scoped, stale-aware engineering self-model derived from runtime observations. It does not claim consciousness or AGI.

## Source audit

The implementation was based on source inspection rather than prior report claims.

Verified Phase 33–36 paths included:

- fail-closed Firebase/API/WebSocket authentication;
- one CognitiveCore/ContextAssembler/SituationFrame path;
- CognitiveRouter, planner, durable execution, distributed leases, idempotency, confirmation, observation, recovery, and replan;
- MemoryStore, MemoryIntelligence, UserModel, TemporalService, and goal integration;
- Phase 35 World Model with local/Firestore persistence and verified observation mapping;
- Phase 36 session-scoped participant awareness, speaker-safe memory and authorization boundaries;
- Phase 36 learning records, versioned skill data, promotion policy, and tool reliability;
- Windows Agent registry/bridge lifecycle and Gemini Live transport;
- ModelGateway provider routing, fallback, cost log, and health methods.

The source contains both conversation-awareness and learning work under the Phase 36 number. Both were preserved and tested.

## Duplicate health/self-evaluation findings

Existing pieces were useful but not a complete operational self-model:

- `SelfEvaluationEngine` evaluates task outcomes and learning; it is in-memory and not subsystem health.
- `BrainObservability` captures bounded cognitive snapshots; it is session-local telemetry.
- AgentBridge and the UI already exposed Windows Agent online/offline state.
- ModelGateway had explicit provider probes and actual call cost/outcome logs.
- Phase 36 learning tracked tool/skill reliability.
- Browser diagnostics and Settings showed isolated connection indicators.

These systems were retained. `HealthEngine` was introduced as the single persistent operational aggregator, not as a competing task evaluator, planner, observer, or world model.

## Baseline and final verification

The verified baseline immediately before Phase 37 was:

```text
Test Files  68 passed
Tests       907 passed
```

Final local gate evidence:

| Gate | Result |
|---|---|
| `npm test` | PASS — 71 files, 927 tests |
| `npm run test:firestore` | PASS — 1 emulator file, 9 tests |
| `npm run lint` | PASS — repository lint command is `tsc --noEmit` |
| `npm run build` frontend | PASS — 2,120 modules transformed |
| `npm run build` server | PASS — `dist/server.cjs` bundled |

The build retains the existing advisory that the main minified JavaScript chunk exceeds 500 kB. It is not a build failure.

## New tests

There are 18 dedicated Phase 37 tests across three files, plus a ModelGateway passive-outcome test, a static Firestore-rule assertion, and a real emulator rule test.

Coverage includes:

- health calculation and status thresholds;
- unknown initial state and false-100 prevention;
- capability availability;
- recent-weighted rolling reliability;
- one-failure tolerance and repeated-failure degradation;
- recovery after authoritative success;
- bounded history;
- stale health;
- restart persistence;
- concurrent updates;
- multi-user isolation;
- provider missing/configured/verified/failure behavior;
- Windows Agent offline behavior;
- database/memory failure behavior;
- truthful self-aware action and memory responses;
- dynamic SituationFrame capabilities;
- diagnostic callback isolation from response truth;
- Firestore owner paths, outage failure, client forgery rejection, and cross-user denial;
- authenticated API ordering and measured UI rendering.

## Capability model

`CapabilityState` records owner, category, availability, confidence, reliability, success/failure/inconclusive counts, consecutive failures, last success/failure/verification times, TTL, and a maximum of 40 observations.

Core capabilities cover authentication, persistence, Cognitive Core, router, planner, execution, observation, recovery, Windows Agent, model provider, Gemini Live, memory, World Model, temporal system, participant awareness, and frontend/backend connectivity. Tool and individual-provider records are added dynamically.

No capability defaults to available. Missing or stale evidence remains unknown/unavailable.

## Health calculations

- Recent observations receive greater weight than old observations.
- A single ordinary failure reduces confidence without destroying availability.
- Three consecutive ordinary tool failures make the tool unavailable.
- Authoritative offline signals can immediately mark availability false.
- Inconclusive/configured-only provider state does not count as success.
- Default health expires after five minutes; faster/slower systems have explicit TTLs.
- Overall status uses weighted measured subsystem scores and critical-dependency checks.
- Overall display is capped below 100 to prevent synthetic perfection.

## Actual observation sources

- authenticated health/cognitive requests;
- read-only memory and World Model persistence probes;
- live AgentBridge socket status;
- actual ModelGateway success/failure cost events;
- explicit credential connection tests;
- actual Gemini Live connection success/failure;
- CognitiveCore/router returned outcomes and exceptions;
- planner returned outcomes and exceptions;
- tool/execution outcomes;
- observation pipeline returns/exceptions;
- recovery history outcomes;
- deterministic participant subsystem self-probe.

Health panel refreshes do not call AI providers and consume no provider credits.

## Self-aware behavior

The old server hard-coded these values as true:

```text
canPlan canExecute canVerify canRecover canReason
```

That static snapshot was removed. SituationFrame now receives a measured per-user capability snapshot.

When Windows Agent is offline or stale, a computer action is rejected before the tool executor with a truthful explanation and “nothing was executed.” Repeatedly failing tools are withheld. When memory persistence is unavailable, LOHZ does not promise durable memory and explains that only current-conversation context remains usable.

## World Model separation

The World Model still describes external/user environment state. The self-model is stored separately and is never written as a world assertion.

```text
SELF:  Windows Agent is currently unavailable.
WORLD: Chrome is currently closed.
```

No self-health observation can become a user preference, identity attribute, goal, or external-world fact.

## Persistence and security

- local atomic persistence: `data/self-model/<encoded-uid>.json`;
- Firestore persistence: `users/{uid}/selfModel/_root`;
- UID ownership validated on read and mutation;
- per-user serialized/transactional updates;
- stale state recalculated after restart;
- authenticated, no-store read APIs only;
- no client mutation API;
- Firestore owner reads only; all client writes denied;
- sanitized detail codes only—no credentials, prompts, provider output, raw arguments, audio, or chain-of-thought.

Participant identity never grants access to another user's self-model or tool authority.

## Health Center UI

The new premium Settings panel displays measured overall/subsystem/tool state. It distinguishes healthy, degraded, critical, offline, stale, and unknown; it never paints configured-but-unverified providers green.

Accessibility includes semantic content, ARIA progress and live regions, text labels independent of color, visible focus styles, and reduced-motion behavior.

## Bugs found and fixed

1. Server capabilities were hard-coded true regardless of live dependencies. Replaced with measured per-user snapshots; regression tested.
2. Provider credentials could be mistaken for connectivity. Configured-only state is now inconclusive/unknown until an actual successful request or test; regression tested.
3. A newly configured provider could inherit an older offline presentation. A newer inconclusive observation now displays unknown until verified; regression tested.
4. Unbounded historical success could hide recent failures. Statistics now use a bounded, recent-weighted window; regression tested.
5. A naïve latest-result model could let one failure destroy confidence. Ordinary reliability tolerates one failure while repeated failures degrade availability; regression tested.
6. Old health could remain green after restart or inactivity. TTL is recalculated at read time; regression tested.
7. Computer commands reached execution before LOHZ expressed known Agent unavailability. Capability gating now refuses before tool execution; regression tested.
8. Memory responses could imply durable recall while persistence was unavailable. Memory capability gating now responds truthfully; regression tested.
9. Cognitive capability metadata was static inside SituationFrame. ContextAssembler now accepts an async per-user capability source; regression tested.
10. Runtime health could have measured construction only. Passive outcome seams now capture actual provider, cognition, planner, execution, observation, recovery, and Gemini Live events.
11. Diagnostic persistence failure could have changed a cognitive response. Observation callbacks are isolated and best-effort; regression tested.
12. A concurrent Phase 38 file imported `RiskLevel` from the learning schema where it is not exported, breaking the final type gate. The import now points to the canonical planner type module without changing behavior.

## Files created

- `src/lib/health/types.ts`
- `src/lib/health/store.ts`
- `src/lib/health/firestoreStore.ts`
- `src/lib/health/engine.ts`
- `src/lib/health/coordinator.ts`
- `src/lib/health/index.ts`
- `src/lib/health/health.test.ts`
- `src/lib/health/firestoreStore.test.ts`
- `src/lib/health/serverWiring.test.ts`
- `src/components/HealthCenter.tsx`
- `docs/PHASE_37_ARCHITECTURE.md`
- `docs/PHASE_37_FINAL_AUDIT.md`

## Files materially modified

- `server.ts`
- `src/components/Settings.tsx`
- `src/lib/cognitive/contextAssembler.ts`
- `src/lib/cognitive/cognitiveCore.ts`
- `src/lib/router/cognitiveRouter.ts`
- `src/lib/integration/pipeline.ts`
- `src/lib/modelGateway/gateway.ts`
- `src/lib/modelGateway/gateway.test.ts`
- `src/lib/worldModel/service.ts`
- `firestore.rules`
- `src/lib/firestoreRules.test.ts`
- `src/lib/persistence/firestoreEmulator.test.ts`
- `src/lib/skills/types.ts` (canonical type-import compatibility only)

## Remaining limitations

- There is no always-on global health daemon. State refreshes on authenticated health/cognitive requests and actual runtime events; TTLs make idle state stale rather than falsely healthy.
- Provider connectivity is deliberately unknown until real use or an explicit test. This audit did not call live AI providers, so no credits were consumed for health verification.
- In local mode, TemporalService is not installed unless the existing Firestore composition is active; the panel reports this honestly.
- Health scores are engineering heuristics over bounded evidence, not formal SLA measurements.
- Frontend/backend connectivity is verified by the authenticated health request path, not by an external synthetic monitor.
- Tool reliability is user-scoped; the system does not pool one user's outcomes into another user's health.
- The UI was type/build tested but not validated against every physical display or screen reader.

## Phase 38 readiness

`READY`, with the limitations above. Phase 38 may consume the read-only capability snapshot, but it must not write health scores, reinterpret unknown state as available, bypass authentication/authorization, or merge self-model data into the World Model.

## Final statement

Phase 37 implements a truthful operational self-model and real-time health center from bounded evidence. It does not implement consciousness, autonomous self-modification, or AGI.

`PHASE 37 COMPLETE`

