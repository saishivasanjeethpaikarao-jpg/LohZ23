# LOHZ Phase 44 Architecture

## Scope and boundary

Phase 44 adds a bounded, evidence-driven repair coordinator to the existing Phase 43 controlled code-change proposal engine. It does not add unrestricted self-modification, arbitrary shell access, automatic approval, deployment, or a perpetual repair loop.

The production lifecycle is:

```text
bounded operational signal
  -> deduplicated incident
  -> repository-backed hypothesis
  -> fixed-command sandbox reproduction
  -> caller-supplied structured patch candidate
  -> targeted verification
  -> Phase 43 security + test + typecheck + build verification
  -> human approval through Phase 43
  -> explicit Phase 43 apply acknowledgement
  -> repaired incident + regression memory + health success
```

An error message alone cannot produce a verified repair. Repository evidence and a failing reproduction are required before a candidate can be evaluated.

## Reused Phase 43 controls

Phase 44 reuses one `ControlledRepository`, `CodeChangeProposalEngine`, `FixedSandboxExecutor`, and `SelfCodingStore`. It does not create a second patching or authorization system.

The inherited Phase 43 controls remain authoritative:

- repository allowlists and containment checks;
- structured create/update patches only;
- protected authentication, authorization, credential, safety, test, configuration, and self-coding files;
- immutable file hashes and approval digests;
- fixed sandbox commands;
- explicit administrator approval and apply acknowledgement;
- per-user persistence and audit records;
- no deploy route and no arbitrary shell route.

## Detection and incident state

Accepted signal sources are:

- runtime errors;
- failed tests;
- TypeScript errors;
- build errors;
- integration failures;
- repeated execution failures;
- health degradation;
- provider failures.

Runtime, test, TypeScript, build, and integration signals create a detected incident immediately. Noisier execution, health, and provider signals require three matching observations. Fingerprints normalize changing numbers and long hexadecimal identifiers to reduce duplicate incidents.

Incidents use this state machine:

```text
observing -> detected -> hypothesis_ready -> reproduced
                                          -> needs_user

reproduced -> candidate_verified -> repaired
           -> reproduced          (failed attempt, retry available)
           -> needs_user          (two failed attempts)
```

`dismissed` is also terminal. Evidence, attempts, revision, timestamps, source, occurrence count, reproduction output, and the linked Phase 43 proposal are retained. Evidence is bounded to 30 entries and signal text to 4,000 characters.

## Evidence and diagnosis

`AutonomousRepairEngine.investigate` sends bounded diagnostics to the controlled repository diagnostic index and uses Phase 43 affected-file discovery. A hypothesis records:

- a root-cause summary;
- captured affected-file references;
- supporting evidence IDs;
- a bounded heuristic confidence;
- the explicit label `heuristic_not_probability`.

No affected file produces a low-confidence result and `needs_user`. Regression memories can contribute limited retrieval evidence, but they are untrusted data and never executable instructions.

## Reproduction and verification

Reproduction accepts only one of these fixed targets:

- an allowlisted set of at most 12 test files;
- TypeScript typecheck;
- production build.

A valid reproduction must fail with a real non-timeout exit and have repository evidence. An inconclusive or passing reproduction moves the incident to `needs_user`.

A repair candidate is accepted only after reproduction. The sandbox first applies the structured candidate to an isolated copy and reruns the targeted reproduction. If it passes, the candidate enters the existing Phase 43 engine, which runs the full security, test, TypeScript, and build verification sequence. Only then can the incident become `candidate_verified`.

The fixed Windows command launcher invokes npm's validated `npm-cli.js` through `process.execPath` with `shell: false`. The sandbox receives a private dependency snapshot rather than a writable link to live `node_modules`.

## Approval and application

Phase 44 intentionally has no direct apply operation. A verified candidate must still traverse the separate Phase 43 lifecycle:

```text
sandbox_verified
  -> approval_requested
  -> approved by authenticated administrator
  -> explicit apply acknowledgement
  -> Phase 43 applies digest-bound patch
```

`finalizeAppliedRepair` verifies that the exact linked proposal is already in Phase 43 status `applied`. It cannot approve or apply a proposal itself.

## Regression memory

Only an applied and verified repair produces a regression memory. The record contains the bug, cause, fix description, tests, affected components, proposal identity/version, and verification time. It is:

- UID scoped;
- restart-persistent;
- immutable on creation;
- bounded to 150 records per user;
- retrieved by bounded token ranking (maximum eight results);
- explicitly marked `untrustedData: true`;
- never executable code or authorization.

## Persistence and concurrency

The in-memory store supports tests. The local JSON adapter supports restart persistence on one host. The Firestore adapter uses transactions for incident creation and compare-and-set revision updates and keeps regression records immutable.

Firestore rules allow owner reads and deny browser writes for `bugIncidents` and `regressionMemories`; trusted server code performs writes. Every engine lookup is explicitly UID scoped.

Compare-and-set prevents a stale incident transition from overwriting a newer revision. Phase 44 does not yet provide a dedicated distributed lease around expensive sandbox repair attempts, so simultaneous servers can perform redundant candidate work even though only a valid state transition is committed.

## Monitoring integration

`BugSignalMonitor` adapts bounded events from:

- model-provider outcomes;
- Windows tool/execution outcomes;
- planner and cognitive pipeline exceptions;
- execution-engine failure outcomes;
- degraded or critical health snapshots.

Monitoring is best-effort and catches its own failures so it cannot change the truth of the operation being observed. It records signals only; there is no timer, background self-repair loop, or automatic candidate generation.

Administrator-only `/api/self-coding` endpoints expose signal ingestion, incident inspection, explicit investigation, explicit reproduction, explicit candidate verification, finalization, metrics, and regression-memory retrieval. Existing authentication and credential-administrator middleware applies to all routes.

## Health integration

The self-model exposes a zero-weight `self_repair` capability. Zero weight prevents an unobserved optional repair capability from distorting overall health.

- Failed candidate verification records a repair failure observation.
- Successful sandbox verification alone does not claim repaired health.
- Health success is recorded only after the exact verified proposal has been human-approved, applied, and finalized.

## Safety invariants

- Diagnostics, prior fixes, and user-supplied patch descriptions are untrusted data.
- No error message is treated as a root cause by itself.
- No candidate is called repaired before targeted and full verification.
- Maximum repair attempts per incident: two.
- Low confidence, timeout, ambiguous reproduction, or exhausted attempts requires user intervention.
- Learning cannot modify authentication, authorization, credentials, safety policy, or test gates.
- No arbitrary command, filesystem, deployment, or continuous mutation interface is introduced.

## Production limitations

- Detection covers wired server events and authenticated administrator ingestion, not all operating-system logs.
- Patch content is structured input from a controlled caller; Phase 44 does not generate trusted code autonomously.
- Static diagnosis is a bounded heuristic, not proof or a calibrated probability.
- The sandbox dependency copy is intentionally safer but expensive on Windows.
- There is no multi-server lease for the expensive reproduce/candidate stage.
- Evaluation measurements are small controlled fixtures, not production repair-rate claims.
