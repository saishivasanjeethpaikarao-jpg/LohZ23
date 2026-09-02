# Counterfactual Reasoning Experiment

## Hypothesis

LOHZ can evaluate alternative states of the world and reason about the difference between actual outcomes and plausible counterfactuals without assuming the observed world is the only possibility.

## Dataset

A synthetic decision dataset containing short event sequences with a baseline outcome and one or more plausible alternative conditions. Each case specifies:

- observed state;
- intervention or condition change;
- alternative world state;
- resulting outcome under the alternative condition.

## Method

The experiment asks the assistant to explain what would likely have happened under a changed condition while staying grounded in the actual observed state. It evaluates whether the assistant separates actual evidence from hypothetical situations.

## Baseline

The baseline is a simple outcome projection that ignores alternative conditions and treats the observed result as fixed.

## Metric

- counterfactual accuracy;
- alternative-state discrimination score;
- explanation validity;
- confidence calibration on hypothetical scenarios.

## Expected result

LOHZ should outperform the static baseline by recognizing the difference between what happened and what would likely have happened under a different condition.

## Kill criterion

The experiment is killed if it cannot separate observed facts from hypothetical assumptions or if it invents ungrounded outcomes with high confidence.

## Actual result

This report remains sandboxed and non-promotional. The system is assessed only in a research setting, without modifying live assistant logic or production execution.

## Conclusion

Counterfactual reasoning is a useful intelligence probe for LOHZ because it tests whether the assistant can reason under alternative conditions without overclaiming certainty.
