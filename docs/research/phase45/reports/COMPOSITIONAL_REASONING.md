# Compositional Reasoning Experiment

## Hypothesis

LOHZ can compose simpler reasoning components into a valid solution for more complex tasks, rather than relying only on monolithic template matching.

## Dataset

A synthetic task set made of small reasoning primitives, including:

- attribute comparison;
- ordering and ranking;
- dependency checks;
- combination constraints;
- multi-step task assembly.

Each complex task is built from several simple operations that must be combined correctly.

## Method

The assistant is tested on tasks where the final result depends on correctly chaining known simple patterns. The evaluation checks whether it can recombine local operations into the correct overall structure.

## Baseline

The baseline is a direct template-response model that tries to match the final task form without identifying its component structure.

## Metric

- correct composition rate;
- path-validity score;
- error decomposition quality;
- generalization to unseen composite tasks.

## Expected result

The system should show improved performance when reasoning explicitly through subcomponents and then combining them correctly.

## Kill criterion

The experiment is killed if the assistant produces a final answer without correctly reflecting the underlying primitive logic or collapses into brittle template matching.

## Actual result

The experiment remains isolated to the research layer. No live routing or planning logic was modified.

## Conclusion

Compositional reasoning is relevant to LOHZ because many real assistant tasks require combining simple understanding patterns into a coherent, larger plan.
