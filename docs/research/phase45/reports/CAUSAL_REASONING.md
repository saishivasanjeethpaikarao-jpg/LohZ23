# Causal Reasoning Experiment

## Hypothesis

LOHZ can distinguish correlation from causation in controlled environments when the task includes intervention and confounder structure.

## Dataset

A synthetic causal dataset built from controlled state-transition tasks with three classes:

- pure correlation without causal influence;
- common-cause confounding;
- true intervention effects.

The dataset includes simple causal graphs with variables A, B, C and a small set of intervention trials such as:

- no intervention;
- controlled intervention on A;
- controlled intervention on B;
- confounded relationship where A and B share a common cause C.

## Method

The experiment is run in a sandboxed research environment with read-only task traces. The assistant is asked to classify whether a relationship is correlational, confounded, or causal and to explain the reasoning using observed changes before and after intervention.

The method compares:

- raw observational correlation conclusion;
- intervention-aware causal judgment; and
- explanation quality grounded in state transitions.

## Baseline

The baseline is a correlation-only heuristic: if A and B move together, treat the relationship as causal.

## Metric

- causal classification accuracy;
- confounder detection accuracy;
- explanation trace validity;
- intervention sensitivity score.

## Expected result

LOHZ should outperform the correlation-only baseline by correctly identifying when a relationship is merely associated and when an intervention changes the downstream outcome.

## Kill criterion

The experiment is killed if the system cannot reliably distinguish confounding from true causal effect in the controlled tasks, or if explanations do not match the observed intervention trace.

## Actual result

This experiment is documented as a Phase 45 research artifact only. No production runtime or live assistant logic was changed. The current result is protocol readiness: the experiment defines the dataset and evaluation method without promoting any experimental logic into production.

## Conclusion

The causal reasoning experiment is valid as a sandboxed research probe. It provides a clear causal-vs-correlation decision task and a measurable baseline, but it is not yet promoted beyond the isolated research layer.
