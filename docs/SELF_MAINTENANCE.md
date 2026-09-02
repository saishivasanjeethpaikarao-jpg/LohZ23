# LOHZ Phase 48 — Self-Maintenance and Diagnostics

## Scope

Phase 48 adds a bounded engineering self-maintenance layer. It diagnoses operational incidents, inspects the approved repository surface, validates candidate patches in the existing fixed sandbox, compares health before and after a candidate, and records maintenance history. It is not consciousness, unrestricted self-modification, or an autonomous deployment system.

## Reused authorities

- `HealthEngine` and `OperationalHealthCoordinator` remain the source of runtime capability observations.
- `ControlledRepository` is the read-only repository boundary and exact-hunk patch authority.
- `FixedSandboxExecutor` copies only approved files and runs fixed `npm` checks without interpreting generated commands.
- `CodeChangeProposalEngine` owns proposal versioning, security policy, verification, approval, and application.
- `AutonomousRepairEngine` owns incident repetition thresholds, reproduction, candidate verification, and regression memory.

## Phase 48 additions

- `HealthMonitor`: deterministic check definitions, explicit `UNKNOWN`/`UNAVAILABLE` handling, bounded historical snapshots, weighted evidence-based aggregation.
- `DiagnosticEngine`: structured symptoms, evidence, probable causes, confidence, affected capabilities, investigation, and remediation; no model output can override evidence.
- `RepositoryInspector`: bounded file/search/dependency/test inspection plus fixed, non-shell Git status/history reads.
- `VerificationEngine`: before/after health comparison that rejects regressions and unknown post-state.
- `ControlledGitIntegration`: only explicit approval, validated relative paths, fixed `git add`/`commit`/`revert` operations; never force-pushes or changes remotes.
- `LocalMaintenanceHistoryStore`: owner-scoped, bounded maintenance records kept separate from user memory.

## Lifecycle

```text
DETECT → DIAGNOSE → PLAN → PATCH PROPOSAL → ISOLATE → TEST → VERIFY
→ APPROVE → PROMOTE → COMMIT → RECORD
```

Existing `/api/self-coding/*` routes remain the proposal/approval surface. Phase 48 adds authenticated administrator routes under `/api/self-maintenance/*` for bounded repository inspection, structured diagnosis, and canonical health views.

## Safety boundaries

Protected authentication, credentials, authorization, safety, tool registry, Firestore rules, verification scripts, and self-coding kernel paths are critical-risk and cannot be autonomously promoted. Repository content is untrusted input. No arbitrary shell, filesystem, Git remote, credential, or deployment operation is accepted from model text.

## Autonomy levels

0. Read-only diagnostics.
1. Recommendations.
2. Candidate patches in the fixed sandbox (default).
3. Automatic validation.
4. Explicit approval for promotion.
5. Opt-in low-risk maintenance only; the policy still rejects protected/high-risk paths.

## Rollback and history

Approved changes are versioned proposals. `ControlledGitIntegration.rollback` requires an explicit approval flag and a validated commit SHA, then uses `git revert --no-edit`; the caller must verify the result. Maintenance records capture diagnosis, affected files, validation, approval, promotion, rollback, and outcome. No record is treated as executable instructions.

## Limitations

Health command checks are injected by the caller rather than run continuously. The default server health view adapts the existing operational health coordinator; deep TypeScript/build/test checks remain expensive and are run by the fixed sandbox during proposal verification. Git commits are opt-in and not invoked automatically by the server. Human approval and native deployment/release controls remain mandatory.
