# LOHZ Phase 40 Architecture

Status: `IMPLEMENTED` and locally `VERIFIED` on 2026-09-01.

## Objective

Phase 40 adds evidence-based adaptation to the existing LOHZ router and learning store. It does not train or fine-tune a model online, rewrite prompts, mutate policies, grant authority, or create a parallel planner.

The production lifecycle is:

```text
verified observation
  -> user-scoped DecisionObservation
  -> comparative proposal
  -> deterministic evaluation
  -> explicit authenticated approval
  -> versioned deployment
  -> bounded safe routing influence
```

No candidate or evaluated proposal affects runtime behavior. Only a deployed version is selectable.

## Decision evidence

`DecisionObservation` records:

- owner UID and immutable observation ID;
- request and normalized task type;
- approach used;
- predicted confidence and confidence kind;
- actual outcome;
- evidence source and environment;
- timestamp.

Supported approaches are:

- `deterministic`;
- `clarification`;
- `model_reasoning`;
- `planner`;
- `known_skill`;
- `recovery_strategy`.

Execution experiences now preserve decision provenance. The approach is derived from the actual plan source and execution lineage: deterministic single-step, multi-step planner, skill-sourced plan, or recovery/replan path. Verified execution and observation state determines the actual outcome.

Inconclusive and not-applicable records may describe interaction patterns but are never counted as calibration success or failure.

## Calibration

Phase 40 compares the recorded score with verified binary outcomes only.

Metrics include:

- sample count;
- mean score;
- empirical verified-success rate;
- mean absolute score/outcome gap;
- diagnostic Brier score;
- five bounded score bins.

Router and planner confidence values are labelled `heuristic`. Their metrics therefore carry `heuristic_score_diagnostic`; the system does not claim they are probabilities. `provider_calibrated` is a distinct label for a future source that genuinely supplies calibrated probabilities.

Fewer than five verified observations returns `insufficient_evidence` and null aggregate metrics.

## Proposal and deployment model

An `AdaptationVersion` contains:

- owner UID, stable adaptation ID, and immutable version;
- task type, baseline approach, and recommended approach;
- bounded observation IDs;
- sample counts and comparative success rates;
- improvement estimate;
- lifecycle and approval metadata;
- replacement provenance;
- immutable safety constraints.

Proposal requirements:

- safe normalized task type;
- at least three verified samples for the current baseline;
- at least three verified samples for a competing approach;
- at least two eligible approaches;
- recommended approach differs from the baseline;
- empirical improvement of at least 0.15.

Lifecycle:

```text
candidate
  -> evaluated or rejected
  -> pending_approval
  -> deployed
  -> retired when a newer approved version deploys
```

Every deployment requires a matching authenticated UID, an explicit `approved: true`, and the exact approval request ID.

## Runtime routing seam

The existing `CognitiveRouter` asks the adaptive service for a deployed user/task recommendation after authentication and participant authorization checks.

The safe transition matrix is intentionally small:

- any eligible primary-user route may become more cautious by requesting clarification;
- ordinary Tier 1 chat may use model reasoning when an approved deployment recommends it;
- planner, known-skill, and recovery recommendations remain inside the existing Tier 3 planner/execution machinery;
- tool routes never gain new tools, arguments, risk levels, permissions, or authority;
- participant speech never uses the primary user's deployment to authorize an action;
- unavailable adaptation storage or service failure preserves the original deterministic route.

Authorization, risk policy, confirmation, capability health, execution, observation, and recovery remain downstream mandatory gates.

## Personalization evidence

`PersonalizationSnapshot` is a bounded, user-scoped evidence view for:

- communication style from non-stale, non-contradicted explicit preference lessons;
- preferred applications from repeated verified `openApp`/`focusApp` experiences;
- output formats from explicit preference lessons;
- recurring workflows from repeated verified task signatures;
- recurring projects from the existing non-stale UserModel project view;
- interaction patterns from repeated routing approaches.

The snapshot sets `sensitiveInferencePerformed: false`. It does not infer age, gender, ethnicity, religion, health, sexuality, or other sensitive attributes. Participant statements do not enter this path unless normal authenticated-user ownership rules first create valid user evidence.

Personalization evidence does not silently mutate UserModel or prompts. It can support a later controlled proposal or be inspected through the authenticated read endpoint.

## Persistence and isolation

Phase 40 extends the existing `LearningStore` implementations:

- in-memory test store;
- restart-safe local JSON store;
- Firestore store.

Decision observations are immutable. Adaptation versions use transactional version heads in Firestore. All reads and writes include the authenticated UID. Firestore clients may read only their own records; decision observations, adaptation versions, and heads are server-write-only.

Collections:

- `users/{uid}/decisionObservations/{observationId}`;
- `users/{uid}/adaptations/{adaptationVersionId}`;
- `users/{uid}/adaptationHeads/{adaptationId}`.

## API surface

Authenticated read endpoints:

- `GET /api/adaptation/calibration`;
- `GET /api/adaptation/personalization`;
- `GET /api/adaptations`.

Controlled mutation endpoints:

- `POST /api/adaptations/propose`;
- `POST /api/adaptations/:id/versions/:version/evaluate`;
- `POST /api/adaptations/:id/versions/:version/request-approval`;
- `POST /api/adaptations/:id/versions/:version/approve`.

There is no client endpoint for writing decision observations or directly deploying a version.

## Security invariants

Every adaptation version declares:

```text
policyMutable = false
authorizationEffect = none
riskReductionAllowed = false
toolArgumentsMutable = false
```

Historical text is never executed or inserted into policy. Task signatures are restricted to a safe vocabulary and reject prompt, instruction, authentication, credential, permission, policy, and command-like tokens.

## Limitations

- Model-reasoning and clarification outputs normally lack an external verifier. They remain inconclusive until a future controlled feedback/verifier path supplies trustworthy outcomes, so they cannot independently satisfy proposal evidence requirements today.
- Calibration is diagnostic for heuristic scores, not proof of probabilistic calibration.
- Personalization is conservative and evidence-facing; it does not silently rewrite response style or application defaults.
- A known-skill or recovery recommendation does not force execution. Existing skill matching, planner validation, authorization, confirmation, observation, and recovery still decide what can happen.
- No background experimentation or automatic A/B testing is performed.
- No live AI-provider call is part of Phase 40 evidence, proposal, evaluation, or deployment.

