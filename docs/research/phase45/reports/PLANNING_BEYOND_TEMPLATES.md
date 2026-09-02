# Planning Beyond Fixed Templates Experiment

## Hypothesis

LOHZ can produce task plans that adapt to the situation rather than relying only on fixed templates.

## Dataset

A plan-generation dataset with tasks that vary in several ways:

- constraints;
- dependencies;
- resource scarcity;
- optional branches;
- reorderable steps;
- unexpected obstacles.

The dataset includes tasks that require plan adaptation beyond standard canned workflows.

## Method

The assistant is asked to generate a plan for a task variant that differs from a familiar template. The evaluation checks whether the plan stays valid under changed task conditions while preserving relevant structure.

## Baseline

The baseline is the fixed-template workflow generator that reuses the most similar prior template without adapting to new constraints.

## Metric

- plan validity;
- constraint satisfaction;
- adaptation score;
- re-planning success under novelty.

## Expected result

The system should adapt the plan when the task differs from the familiar template, rather than blindly applying the same structure.

## Kill criterion

The experiment is killed if the assistant fails when simple constraints differ, or if it cannot re-sequence steps without a fallback template.

## Actual result

This is a research-only report. It does not modify any live production planning or execution system.

## Conclusion

Planning beyond fixed templates is an important intelligence lens for LOHZ because real tasks often require adaptation, not just recall of a known process.
