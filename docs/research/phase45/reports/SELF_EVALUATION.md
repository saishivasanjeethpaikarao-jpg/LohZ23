# Self-Evaluation Experiment

## Hypothesis

LOHZ can assess its own confidence, detect uncertainty, and identify blind spots in a way that is useful for downstream decision quality without triggering live modifications.

## Dataset

A synthetic evaluation set containing tasks with:

- high-confidence correct answers;
- borderline answers;
- ambiguous or under-specified tasks;
- cases with hidden assumptions;
- tasks where a correct answer depends on abstaining or asking for more information.

## Method

The assistant is asked to answer a task, rate its confidence, identify which assumptions are risky, and state whether it should proceed, abstain, or ask for clarification. Results are compared against the true task quality and the known ambiguity of the prompt.

## Baseline

The baseline is a no-self-check model that answers directly and reports confidence only via a generic tone cue, without explicit self-assessment.

## Metric

- calibration quality;
- blind-spot detection;
- abstention appropriateness;
- usefulness of self-critique under uncertainty.

## Expected result

The system should become better calibrated when it explicitly evaluates its own assumptions and identifies conditions under which a claim is weak.

## Kill criterion

The experiment is killed if the assistant consistently fails to recognize uncertainty, fails to flag weak assumptions, or uses self-evaluation as a pretext for unsupported certainty.

## Actual result

This report remains isolated to the research layer. No production policy, planner, or user-facing behavior was modified.

## Conclusion

Self-evaluation is a meaningful research area because a useful assistant should know when it needs more evidence rather than acting as though every answer is equally reliable.
