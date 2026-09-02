# LOHZ Phase 45 — Experimental Module Registry

## Purpose

This registry defines the experimental modules for the isolated Phase 45 research layer. Each module is designed to test a general-intelligence mechanism in a controlled setting, without allowing the experiment to affect live assistant behavior.

## Allowed boundaries

- Research artifacts stay under `docs/research/phase45`.
- Experiments use local synthetic datasets and controlled task environments.
- Results are logged as evidence only.
- No direct modification of production code or runtime behavior is permitted.

## Module descriptions

| Module | Goal | Production boundary |
|---|---|---|
| CausalReasoning | Distinguish correlation from intervention and causal influence | No live causal reasoning is promoted into production |
| CounterfactualReasoning | Evaluate what would happen under alternative conditions | No direct behavioral changes without safe pipeline approval |
| TransferLearning | Measure whether structure learned in one domain transfers to another | No model weights are applied to live tasks |
| CompositionalReasoning | Test whether simpler components can combine into valid complex reasoning | No part of the live routing stack is modified |
| PlanningBeyondTemplates | Detect flexible plans beyond fixed workflows | No planner rewrite is allowed in the research layer |
| UncertaintyReasoning | Calibrate confidence under ambiguity and incomplete evidence | No change to confidence policy or tool gating |
| KnowledgeAcquisition | Evaluate how knowledge is added or revised from evidence | No memory writes occur in production paths |
| SkillTransfer | Measure transfer of organization, structure, and task decomposition skills across contexts | No live work-product changes are applied |
| SelfEvaluation | Check whether the system can assess confidence and identify blind spots | No production self-modification is enabled |
| WorldModelPrediction | Test state-to-prediction-to-action-to-observation loops | No runtime loop or control policy is modified |

## Module contract

Each module should report:

- hypothesis;
- dataset;
- method;
- baseline;
- metric;
- expected result;
- kill criterion;
- actual result;
- conclusion.

## Safety requirements

Every module must satisfy these checks:

1. It remains in the research sandbox.
2. It produces evidence rather than autonomous behavior.
3. It does not change production memory or execution paths.
4. It is evaluated against task relevance and real-environment usefulness.
5. Any promotion requires the repo's existing controlled safe-change pipeline.

## Research signal

The useful signal is not "large benchmark score" but whether LOHZ can:

- explain its reasoning in a traceable way;
- adjust when evidence contradicts its assumptions;
- transfer structure across tasks;
- recognize uncertainty and abstain when appropriate;
- update its world model after observation.

That is the intended evidence for Phase 45.
