# LOHZ Phase 45 — Experiment Protocol

## Objective

Every experiment in this layer must test a bounded intelligence mechanism under controlled conditions without directly changing live behavior.

## Required experiment structure

Every experiment must contain the following fields:

1. Hypothesis
2. Dataset
3. Method
4. Baseline
5. Metric
6. Expected result
7. Kill criterion
8. Actual result
9. Conclusion

## Protocol rules

- Research is isolated to this directory.
- Experiments must operate on synthetic or locally controlled dataset artifacts.
- No production files are edited as part of any experiment.
- No live production prompts, policies, tools, memory structures, or agent behavior may be changed.
- Any promotion outside the research layer requires the existing safe change pipeline.

## Evaluation philosophy

Experiments should measure useful intelligence in LOHZ's actual environment, not generic benchmark performance. A good signal is:

- causal understanding under treatment vs. confounding;
- transfer of structure across contexts;
- model updating from observation;
- recognition of uncertainty and confidence calibration;
- decomposition and planning beyond brittle templates.

## Kill criterion

A study is rejected if any of the following occur:

- the experiment attempts direct runtime modification;
- it produces untraceable or unverifiable claims;
- it optimizes for a leaderboard score without environment relevance;
- it cannot show a clear baseline comparison;
- it fails to isolate confounders and dataset bias; or
- it causes unsafe or unstable effects in the live assistant path.

## Research-output rule

The output of each experiment is a report, not a production patch. Results should be documented and reviewed for relevance before any promotion.

## Causal experiment requirement

The causal experiment must explicitly test correlation versus causation using controlled environments and intervention logic.

## Transfer experiment requirement

The transfer experiment must train or test skills across different contexts and evaluate whether structure learned in one context transfers to another.

## World-model experiment requirement

The world-model experiment must test the loop:

current state -> prediction -> action -> observation -> model update

It must report prediction accuracy and adaptation over repeated cycles.
