# Uncertainty Reasoning Experiment

## Hypothesis

LOHZ can express uncertainty appropriately when evidence is incomplete or conflicting, and avoid false confidence in ambiguous situations.

## Dataset

A synthetic evidence dataset with:

- complete evidence;
- partial evidence;
- conflicting evidence;
- missing observations;
- low-quality signals.

Each case requires a confidence judgment and a summary of how much the conclusion depends on missing information.

## Method

The assistant is asked to classify or decide under varying evidence quality and to state its confidence and uncertainty sources. Its output is compared against the true evidence state and the known task uncertainty.

## Baseline

The baseline is a confident answer model that always gives a definitive conclusion without a calibrated uncertainty signal.

## Metric

- calibration error;
- uncertainty awareness score;
- abstention appropriateness;
- evidence-quality sensitivity.

## Expected result

LOHZ should become more calibrated as evidence becomes weaker, expressing uncertainty when the evidence does not support a firm answer.

## Kill criterion

The experiment is killed if the assistant repeatedly overstates certainty or produces confident claims despite missing or contradictory evidence.

## Actual result

This report is confined to the research layer and does not change production confidence, tool gating, or policy behavior.

## Conclusion

Uncertainty reasoning is essential to real-world assistant behavior because calibrating confidence is more useful than pretending certainty in ambiguous conditions.
