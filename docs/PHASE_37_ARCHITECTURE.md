# LOHZ Phase 37 Architecture — Operational Self-Model and Health Center

Date: 2026-09-01

## Scope

Phase 37 gives LOHZ a bounded engineering model of its own operational state. It does not model consciousness, personality, identity, or the external environment.

The Phase 35 World Model remains the authority for external/user-environment assertions. The Phase 37 Self Model contains only LOHZ runtime capability observations.

## Existing systems retained

- `SelfEvaluationEngine` remains an after-action task/learning evaluator.
- `BrainObservability` remains bounded in-session cognitive telemetry.
- `AgentBridge` remains the Windows Agent connection authority.
- `ModelGateway` remains the provider/cost/fallback authority.
- Phase 36 `SkillLearningService` retains skill/tool learning statistics.
- Existing persistence, CognitiveCore, router, planner, execution, observation, recovery, memory, temporal, world-state, and conversation systems remain authoritative.

`HealthEngine` is the single operational aggregator over those sources. It does not replace them or create another cognitive loop.

## Data flow

```text
actual runtime source
  |-- authenticated API request
  |-- memory/world persistence read probe
  |-- AgentBridge socket status
  |-- ModelGateway call outcome
  |-- explicit provider connection test
  |-- Gemini Live connection outcome
  |-- CognitiveCore/router returned outcome
  |-- planner outcome
  |-- execution/tool outcome
  |-- observation outcome
  |-- recovery outcome
  `-- participant subsystem self-probe
             |
             v
   bounded CapabilityObservation
             |
             v
   user-scoped CapabilityState
             |
             v
        HealthEngine
             |
       +-----+----------------+
       |                      |
 HealthSnapshot       dynamic cognitive capabilities
       |                      |
 /api/health          SituationFrame / response gate
       |
 Settings > System Health
```

Health recording is passive. Opening the health panel does not call an AI provider. Provider connectivity becomes verified only through a real provider request, an explicit credential connection test, or a Gemini Live connection.

## Capability model

Each `CapabilityState` stores:

- authenticated owner UID;
- capability ID and category;
- derived availability, confidence, and rolling reliability;
- lifetime success, failure, and inconclusive counts;
- consecutive failures;
- last success, failure, observation, and verification times;
- capability-specific staleness threshold;
- at most 40 bounded observations.

Observation text is reduced to sanitized detail codes. Credentials, provider output, prompts, raw tool arguments, raw audio, and chain-of-thought are never stored.

Core health capabilities are:

- authentication;
- persistence;
- Cognitive Core and router;
- planner, execution, observation, and recovery;
- Windows Agent;
- model providers and Gemini Live;
- memory, World Model, and temporal system;
- participant awareness;
- frontend/backend connectivity.

Tool capabilities use `tool:<registered-name>`. Provider capabilities use `provider:<provider-name>`.

## Reliability calculation

The newest observation receives the greatest weight. For a rolling window ordered oldest to newest, observation `i` receives weight `i + 1`:

```text
rolling reliability = weighted successes / (weighted successes + weighted failures)
```

Inconclusive observations do not count as successes or failures. They describe configured-but-unverified state without fabricating connectivity.

A single ordinary failure reduces reliability but does not erase availability. Three consecutive ordinary failures make a tool unavailable. A newer authoritative availability signal, such as an offline AgentBridge socket state, can immediately mark the associated capability unavailable. A later authoritative success resets consecutive failures and enables recovery.

Old observations are evicted after 40 entries, so historical success cannot permanently hide recent regressions.

## Staleness

- default capability TTL: 5 minutes;
- Windows Agent: 30 seconds;
- tool reliability: 30 minutes;
- verified Gemini Live connection: 10 minutes.

Expired state becomes `stale` and unavailable until re-observed. Unknown and stale are distinct from verified failure.

## Health calculation

Each subsystem receives a bounded score from measured availability, rolling reliability, confidence, and staleness. Core subsystems have explicit weights. Authentication, persistence, Cognitive Core, and router are critical dependencies.

```text
overall = weighted subsystem scores / total weight
healthy  = score >= 80 and no critical dependency unavailable
degraded = score >= 45 and no critical dependency unavailable
critical = otherwise
```

The displayed value is capped at 99. LOHZ never manufactures a perfect 100 from structural checks or sparse evidence.

## Persistence and isolation

Local mode writes an atomic per-user document below `data/self-model`. Firestore mode writes:

```text
users/{authenticatedUid}/selfModel/_root
```

Local and Firestore mutations are transactional/serialized per user. Documents validate ownership on every load and mutation. Firestore clients may read only their own document and cannot write capability evidence or health scores; authenticated server code performs all mutations.

The self-model is restart-safe. Staleness is recalculated at read time, so a restarted process cannot treat old health as current.

## Cognitive behavior

`ContextAssembler` now accepts a per-user asynchronous capability source. SituationFrame receives measured availability instead of hard-coded `canPlan`, `canExecute`, `canVerify`, `canRecover`, and `canReason` values.

The existing `CognitiveRouter` has a fail-safe capability gate before execution:

- computer-control requests stop truthfully when Windows Agent health is offline/stale;
- repeatedly failing tools are withheld;
- persistent-memory queries/promises stop when memory persistence is unavailable;
- capability-gate failure prevents tool execution rather than guessing.

All normal authentication, participant authorization, risk, confirmation, tool policy, execution, observation, and recovery gates remain in force.

## Health UI

The Health Center is a new Settings section. It shows:

- measured overall score and status;
- every subsystem with healthy/degraded/critical/offline/unknown/stale state;
- per-subsystem score and sanitized observation code;
- observed tool reliability;
- manual refresh and 15-second polling only while the section is open.

The UI uses semantic sections/articles, an accessible progress bar, an ARIA live region, visible keyboard focus, readable status text in addition to color, and reduced-motion behavior.

## API

Both endpoints are behind the existing fail-closed `/api` authentication middleware and return `Cache-Control: no-store`:

- `GET /api/health`
- `GET /api/self-model/capabilities`

There is no client write endpoint.

## Graceful degradation

- missing credential: provider unavailable;
- configured but unused credential: provider unknown, not healthy;
- provider failure: rolling reliability decreases;
- AgentBridge offline/stale: computer action blocked;
- persistence failure: health API fails closed if the self-model cannot be persisted;
- no temporal service in local mode: temporal health reports unavailable;
- idle system: old observations become stale rather than remaining permanently green.

