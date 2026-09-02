# LOHZ Phase 45 — General Intelligence Research / Experimentation Layer

## Purpose

This layer is intentionally isolated from the live assistant. It is a research sandbox for testing general-intelligence mechanisms without destabilizing production behavior.

This is not an AGI claim, an autonomy claim, or a production control path. The goal is to measure useful intelligence in LOHZ's actual environment using small, controlled experiments, synthetic tasks, and structured evaluations.

## Safety boundary

The Phase 45 layer must never:

- directly modify production prompts, memory, tool routing, execution policy, or planner logic;
- alter the live assistant runtime or user-facing behavior;
- bypass the existing safe change pipeline; or
- optimize for abstract benchmark scores without checking task relevance to LOHZ's real environment.

The layer is restricted to:

- research notes;
- synthetic datasets and evaluation scripts kept under this directory;
- isolated experiment logs and reports;
- simulation outputs that are not promoted into live execution paths.

Promotion from research to product requires the existing safe change pipeline already defined in the repository, including verification and human approval gates.

## Directory layout

```text
docs/
  research/
    phase45/
      README.md
      RESEARCH_MODULES.md
      EXPERIMENT_PROTOCOL.md
      reports/
        CAUSAL_REASONING.md
        TRANSFER_LEARNING.md
        WORLD_MODEL.md
```

## Research modules

The research layer contains the following experimental modules:

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

Each module remains read-only unless a formal promotion path is approved through the repository's existing safe change pipeline.

## Research posture

LOHZ should measure intelligence by actual task usefulness, not by arbitrary AGI benchmark scores alone. The relevant questions are:

- Can the assistant infer structure from limited evidence?
- Can it distinguish signal from noise, correlation from causation, and consequences from assumptions?
- Can it transfer learned structure across domains?
- Can it update its model after observing outcomes and adapt behavior responsibly?
- Does it improve performance on tasks that resemble the real operating environment?

## Execution rule

All experiments in this phase are intentionally isolated from production behavior. Any experiment that changes live logic, active memory, tool policies, or assistant outputs is outside scope and must be rejected.

## Conclusion

Phase 45 is a disciplined research layer: it maps the intelligence questions that matter to LOHZ's actual environment, runs them in bounded experiments, and keeps the results separate from production until the safe change pipeline approves a real promotion.
