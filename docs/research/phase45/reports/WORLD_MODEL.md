# World-Model Prediction Experiment

## Hypothesis

LOHZ can maintain a useful world model by predicting the next state, choosing an action, observing the outcome, and updating its internal model without requiring direct production integration.

## Dataset

A synthetic environment dataset with repeated state-transition tasks. Each task records:

- current state;
- short-horizon prediction;
- candidate action;
- observed outcome;
- delta between expected and actual state;
- the update signal used to refine the model.

Example states may include:

- resource allocation;
- scheduling and queue order;
- dependency chains;
- room/object layout transitions;
- simple task-flow states.

## Method

The assistant runs a loop in a bounded simulation:

1. Observe the current state.
2. Predict the next state.
3. Select an action.
4. Observe the result.
5. Update the model based on the discrepancy.

This is evaluated over multiple cycles in the same environment and across a small set of related tasks.

## Baseline

The baseline is a static model that predicts the next state without incorporating observed errors or update steps.

## Metric

- prediction accuracy;
- action-outcome alignment score;
- model-update usefulness;
- adaptation quality over repeated observations;
- calibration of confidence to observed error.

## Expected result

The system should improve over repeated cycles by reducing prediction error and updating its internal assumptions as new observations come in.

## Kill criterion

The experiment is killed if the model does not improve under observation or if it directly attempts to influence live runtime behavior rather than remaining in the sandbox.

## Actual result

This report is documenting an isolated simulation path only. No production behavior or live memory path was changed. The world-model experiment is, at this stage, a bounded research evaluation artifact and not a release mechanism.

## Conclusion

The world-model experiment is relevant to LOHZ's real environment because it tests how the assistant reasons about state transitions, action consequences, and model correction. It remains a research artifact until it passes the repository's safe change pipeline.
