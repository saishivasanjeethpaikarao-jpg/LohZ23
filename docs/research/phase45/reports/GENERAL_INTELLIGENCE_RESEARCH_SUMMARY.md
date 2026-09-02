# Phase 45 — General Intelligence Research Summary

## Scope

This summary captures the research layer for LOHZ Phase 45. It covers a structured set of experiments designed to probe general-intelligence mechanisms while maintaining strict isolation from production behavior.

## Included research areas

- causal reasoning
- counterfactual reasoning
- transfer learning
- compositional reasoning
- planning beyond fixed templates
- uncertainty reasoning
- knowledge acquisition
- skill transfer
- self-evaluation
- world-model prediction

## Required protocol

Each experiment follows the protocol defined in `docs/research/phase45/EXPERIMENT_PROTOCOL.md` and reports:

- Hypothesis
- Dataset
- Method
- Baseline
- Metric
- Expected result
- Kill criterion
- Actual result
- Conclusion

## Safety rule

These experiments are intentionally sandboxed and are not allowed to directly modify production behavior. Any promotion to live runtime logic requires the existing safe change pipeline and human approval.

## Research value

The useful intelligence signal is not a generic leaderboard-like score. It is whether LOHZ can reason in context, update beliefs under evidence, distinguish causal structure from correlation, generalize across related tasks, and make calibrated judgments about uncertainty.

## Status

Phase 45 is established as an isolated research layer with documentation and controlled experiment reports, without enabling any live production effect.
