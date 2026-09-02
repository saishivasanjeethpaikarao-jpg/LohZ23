# LOHZ Phase 46 — Unified Cognitive Operating System Test Suite

## Objective

This is the largest integration test suite yet for LOHZ. It exercises the unified cognitive pipeline across conversation, memory, task execution, autonomous behavior, recovery, skill reuse, and controlled code-change flow.

Each scenario verifies the pipeline:

```text
INPUT
 -> Perception
 -> Participant Context
 -> SituationFrame
 -> Memory Retrieval
 -> World Model
 -> Self Model
 -> Goal State
 -> Reasoning
 -> Planning
 -> Skill Selection
 -> Authorization
 -> Execution
 -> Observation
 -> Verification
 -> Reflection
 -> Learning Proposal
 -> Memory / World Model / Skill Update
 -> Response
```

No scenario may directly change production behavior without the approved safe-change pipeline.

---

## Scenario 1 — Simple conversation

### Goal

Handle a straightforward user request that requires conversational response with no external action.

### Flow

- Input: ordinary conversation request
- Perception: detect text input and channel
- Participant Context: resolve active user
- SituationFrame: low-risk conversational mode
- Memory Retrieval: retrieve relevant recent memory only if required
- World Model: no strong state change
- Self Model: capability check for conversational answer
- Goal State: answer user
- Reasoning: produce concise reply
- Planning: none or minimal action plan
- Skill Selection: conversational response skill
- Authorization: allowed
- Execution: produce answer
- Observation: response emitted
- Verification: content aligns with request
- Reflection: minimal feedback loop
- Outcome: `SUCCESS`

### Expected result

A simple conversation completes without unnecessary planning or state expansion.

---

## Scenario 2 — Memory request

### Goal

Retrieve and use prior memory without turning memory into an uncontrolled authority.

### Flow

- Input: "What did we decide last time about the project?"
- Perception: detect memory-seeking query
- Participant Context: user identity and chat context
- SituationFrame: memory retrieval task
- Memory Retrieval: fetch relevant memory references
- World Model: check current assumptions against retrieved data
- Self Model: confirm retrieval capability
- Goal State: answer with current best evidence
- Reasoning: reconcile memory against current facts
- Planning: limited retrieval plan
- Skill Selection: memory-recall skill
- Authorization: allowed
- Execution: summarize memory
- Observation: context retrieved
- Verification: memory trace validated
- Reflection: confirm summary fits current context
- Outcome: `SUCCESS` or `UNCERTAIN` if memory is weak

### Expected result

The assistant answers using traceable memory, not vague recollection.

---

## Scenario 3 — Desktop action

### Goal

Perform a bounded desktop action through the existing execution and authorization model.

### Flow

- Input: open the browser or file and perform a simple task
- Perception: detect tool action requested
- Participant Context: user + machine context
- SituationFrame: bounded automation task
- Memory Retrieval: optional previous task context
- World Model: expected state and target action
- Self Model: confirm desktop capability and safety constraints
- Goal State: complete action
- Reasoning: choose exact action
- Planning: step-by-step route
- Skill Selection: desktop automation skill
- Authorization: check tool permissions and scope
- Execution: perform action
- Observation: new screen or file state
- Verification: confirm target action occurred
- Reflection: compare expected result to actual result
- Outcome: `SUCCESS` or `FAILED`

### Expected result

The assistant performs only the validated action and records evidence of the outcome.

---

## Scenario 4 — Multi-step task

### Goal

Coordinate a multi-step task that requires sequencing, verification, and adaptation.

### Flow

- Input: plan and complete a multi-part user task
- Perception: parse task steps and constraints
- Participant Context: active user/context
- SituationFrame: multi-step workflow
- Memory Retrieval: relevant prior patterns
- World Model: expected intermediate states
- Self Model: check which sub-tasks are allowed
- Goal State: end-state objective
- Reasoning: decompose task
- Planning: produce plan with dependencies and fallback
- Skill Selection: task workflow skill
- Authorization: confirm each step
- Execution: complete each step sequentially
- Observation: intermediate states
- Verification: each subtask passes or fails
- Reflection: adjust if failure occurs
- Outcome: `SUCCESS` with explicit evidence or `FAILED` with recovery path

### Expected result

The assistant handles dependencies coherently and does not assume success from partial completion.

---

## Scenario 5 — Multi-person conversation

### Goal

Handle a conversation with multiple active participants and changing roles.

### Flow

- Input: discussion among multiple participants
- Perception: identify speakers and topics
- Participant Context: build participant map and roles
- SituationFrame: multi-party state with shared goals and side discussions
- Memory Retrieval: recall prior agreements and conflicts
- World Model: maintain conversation facts and likely intents
- Self Model: confirm ability to mediate, summarize, or ask clarifying questions
- Goal State: produce accurate summary or resolution
- Reasoning: separate roles, facts, and unresolved points
- Planning: decide whether to summarize, ask, or defer
- Skill Selection: conversation orchestration skill
- Authorization: no action beyond allowed conversation output
- Execution: produce reply or summary
- Observation: user reaction
- Verification: the summary matches participants' actual statements
- Reflection: check if there was ambiguity
- Outcome: `SUCCESS`, `NEEDS_USER`, or `UNCERTAIN`

### Expected result

The system distinguishes speaker roles and avoids collapsing multiple participant intents into one.

---

## Scenario 6 — Autonomous task

### Goal

Handle a bounded autonomous task with a clear goal and safe execution envelope.

### Flow

- Input: request for a low-risk background task
- Perception: detect autonomy candidate
- SituationFrame: autonomous work with deadline and boundaries
- Memory Retrieval: retrieve similar historical tasks
- World Model: expected environment state
- Self Model: confirm role and limits
- Goal State: autonomous objective
- Reasoning: choose path under policy
- Planning: confirm task decomposition and stop conditions
- Skill Selection: autonomous task execution skill
- Authorization: check safety envelope
- Execution: complete bounded automation
- Observation: environment or result changes
- Verification: confirmation signal
- Reflection: evaluate task against goal and risk
- Outcome: `SUCCESS` or `BLOCKED`

### Expected result

Autonomous work remains bounded and traceable. It never bypasses the safe change or authorization gates.

---

## Scenario 7 — Failure + recovery

### Goal

Test the system's ability to report failure honestly and recover without converting uncertainty into false success.

### Flow

- Input: task fails midway due to missing dependency or invalid assumption
- Perception: detect failure signal
- SituationFrame: failure state with missing fact
- Memory Retrieval: look for similar failed steps
- World Model: note difference between expected and actual state
- Self Model: identify whether the system can continue or must seek user input
- Goal State: recover or escalate
- Reasoning: determine root cause and options
- Planning: choose recovery path
- Skill Selection: recovery or clarification skill
- Authorization: re-check safe boundaries
- Execution: attempt recovery or ask for input
- Observation: new state
- Verification: new status clarified
- Reflection: log failure cause and update learning proposal
- Outcome: `FAILED`, `UNCERTAIN`, `NEEDS_USER`, or `SUCCESS` after recovery

### Expected result

The system does not claim success when failure remains unresolved.

---

## Scenario 8 — Skill reuse

### Goal

Use a previously learned or selected skill in a new but related task without brittle copy-paste behavior.

### Flow

- Input: task similar to previous successful task but with changed variables
- Memory Retrieval: identify earlier relevant skill application
- World Model: assess what is analogous versus new
- Self Model: confirm the skill is still in scope
- Goal State: solve the new version of the task
- Reasoning: map old skill to current task
- Planning: adapt workflow rather than rigid reuse
- Skill Selection: choose the reusable skill
- Authorization: domain check
- Execution: perform adapted version
- Observation: result on new task
- Verification: outcome matches task constraints
- Reflection: compare divergence from prior task
- Outcome: `SUCCESS` or `UNCERTAIN`

### Expected result

The assistant reuses skill structure, not just a fixed template.

---

## Scenario 9 — Code bug + repair proposal

### Goal

Handle a bug report and prepare a bounded repair proposal without direct live mutation.

### Flow

- Input: bug or broken behavior report
- Perception: parse bug description and symptoms
- SituationFrame: bounded software diagnosis task
- Memory Retrieval: retrieve related bug history and architectural context
- World Model: infer probable root cause and expected semantics
- Self Model: confirm safe diagnosis scope
- Goal State: identify root cause and propose fix
- Reasoning: review evidence and affected files
- Planning: propose bounded repair and verification steps
- Skill Selection: code-analysis and repair-planning skill
- Authorization: require safe code-change gate
- Execution: generate structured proposal only
- Observation: verification evidence from test or static analysis
- Verification: run allowed checks in controlled context
- Reflection: assess whether the fix matches the actual bug
- Learning Proposal: optional update to memory or design notes
- Outcome: `SUCCESS` only after approved verification, otherwise `NEEDS_USER` or `FAILED`

### Expected result

The assistant remains in the controlled proposal path and does not silently patch production code.

---

## Scenario 10 — Restart recovery

### Goal

Ensure the unified cognitive state and session can recover after restart without inventing lost state.

### Flow

- Input: system restarts mid-task
- Perception: reload state snapshot or reconstruct partial session
- Participant Context: re-identify user and active participants
- SituationFrame: restore current environment task state
- Memory Retrieval: load relevant memory and world assertions
- World Model: restore known facts and uncertainty estimates
- Self Model: recover capability status
- Goal State: determine whether the previous objective is still valid
- Reasoning: decide resume vs. replan vs. ask user
- Planning: rehydrate task plan
- Skill Selection: choose available restarted skill set
- Authorization: re-run checks
- Execution: continue or ask for user direction
- Observation: new task state
- Verification: decision is grounded in recovered evidence
- Reflection: note what state was lost or uncertain
- Outcome: `SUCCESS`, `NEEDS_USER`, or `UNCERTAIN`

### Expected result

Recovery preserves the authoritative state and recognizes when incomplete information requires human input.

---

## Test suite rules

1. Each scenario must end with a clear state result.
2. Uncertainty must remain explicit.
3. No scenario may skip verification.
4. No production mutation is allowed without the safe-change pipeline.
5. Learning updates must be bounded and auditable.

## Pass criteria

A scenario passes when:

- the correct pipeline ordering is followed;
- the stage outputs are explicit;
- uncertainty is not converted into false success;
- the final state is grounded in evidence;
- the system preserves safety boundaries.
