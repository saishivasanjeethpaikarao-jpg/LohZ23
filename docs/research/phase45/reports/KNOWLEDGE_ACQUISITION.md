# Knowledge Acquisition Experiment

## Hypothesis

LOHZ can acquire or revise knowledge from new evidence in a way that improves future decisions without directly modifying production memory paths.

## Dataset

A small evidence stream with repeated tasks where:

- the initial belief is incorrect or incomplete;
- new observations contradict the previous model;
- the correct update requires revising assumptions rather than simply accumulating facts.

## Method

The assistant is evaluated on whether it updates its beliefs when evidence changes, using clear record of prior assumption, new observation, and revised conclusion.

## Baseline

The baseline is a static knowledge model that does not revise prior beliefs when new evidence arrives.

## Metric

- belief-update accuracy;
- contradiction-handling quality;
- revision consistency;
- downstream decision improvement.

## Expected result

LOHZ should revise earlier conclusions when the evidence changes and should demonstrate a more accurate model after updates.

## Kill criterion

The experiment is killed if the system cannot distinguish updated evidence from stale assumptions or if it ignores contradictions.

## Actual result

The experiment stays in the research sandbox with no production-memory writes or runtime modifications.

## Conclusion

Knowledge acquisition is a meaningful intelligence test because real-world utility depends on adapting beliefs when evidence changes rather than preserving outdated assumptions.
