# LOHZ Phase 41 Final Audit

## Verdict

`PHASE 41 COMPLETE`

Phase 41 provides a real, persistent execution-session lifecycle with bounded authorization, conservative restart handling, durable interruption states, and Firestore transaction-backed renewable fenced leases. It continues to use the existing authenticated execution, policy, observation, recovery, and idempotency paths.

## Baseline and final verification

| Gate | Result |
|---|---|
| Baseline before Phase 41 | 73 files, 951 tests passed |
| Phase 41 focused/security tests | 3 files, 21 tests passed |
| Final complete suite | 75 files, 968 tests passed |
| Firestore emulator | 1 file, 11 tests passed |
| TypeScript / lint script | `tsc --noEmit` passed |
| Frontend production build | passed, 2,120 modules transformed |
| Server production bundle | passed, `dist/server.cjs` produced |
| Diff whitespace check | passed; line-ending warnings only |
| Paid/provider calls | none |

The final normal suite adds 17 tests over baseline. The emulator suite adds two Phase 41 tests over the previous nine-test gate.

The Vite build retains the existing warning that one minified chunk exceeds 500 kB. This is a performance warning, not a Phase 41 build failure.

## Implemented

### Durable session model

Implemented the requested fields and additional safety bindings:

- session ID and authenticated user ID
- objective plus immutable digest
- status and current checkpoint
- bounded checkpoint history
- authorization scope
- creation/update/timeout timestamps
- next action and interruption reason
- plan ID/version and request ID
- optimistic version

### Checkpoint and restart behavior

- Local fallback persists atomic session JSON across process recreation.
- Firestore persists sessions under the authenticated user namespace.
- Resume reloads ownership after acquiring the worker lease.
- A stale checkpoint must still pass current-state verification.
- `FAILED` verification blocks; `INCONCLUSIVE` verification pauses.
- Existing step execution/idempotency checkpoints remain authoritative.
- Existing ambiguous-side-effect restart protection remains intact.

### Reauthorization

- Grants expire and are capped at one hour.
- Grants bind to authenticated-user origin, objective digest, plan ID, plan version, exact tool set, and risk ceiling.
- Reauthorization creates a new grant ID.
- The server derives authority from the persisted owned plan, never from client-provided tool/risk claims.
- Normal confirmation and destructive-operation policy remains mandatory.

### Interruption

Implemented durable pause, resume, cancel, timeout, partial/recovery, provider-outage, Windows-Agent-outage, persistence-loss, and failure representations. Cancellation races use session compare-and-set so late worker completion cannot overwrite a user's cancellation.

### Distributed behavior

- Firestore transactions arbitrate acquisition across independent server repository instances.
- Leases carry server-generated lease tokens and monotonically increasing fencing tokens.
- Automatic heartbeat renewal keeps long-running ownership alive.
- Checkpoint compare-and-set validates the live lease and fencing token.
- Expired workers cannot write after takeover.
- No process-global lock is used for Phase 41 session ownership.

The existing PlanExecutionEngine's in-process map remains only a same-process optimization; distributed correctness comes from Firestore leases.

## Tests added

Normal suite coverage includes:

- local restart persistence and resume
- two-server concurrent worker exclusion
- direct Firestore transaction race
- authorization expiry and explicit reauthorization
- cancellation while a worker is running
- pause and verified resume
- partial completion and recovery
- provider-outage checkpoint preservation
- stale checkpoint with inconclusive verification
- cross-user read/resume/cancel isolation
- fencing after lease expiry/takeover
- automatic lease renewal during a long runner
- timeout without runner invocation
- durable terminal failure without silent retry
- authenticated route scope derivation
- cross-user HTTP non-disclosure
- changed-plan reauthorization rejection
- Firestore rule audit

Firestore emulator coverage includes:

- owner session reads, cross-user denial, and browser checkpoint/lease forgery denial
- simultaneous lease acquisition from two independent Firestore-backed stores, with exactly one winner

## Security verification

- Authentication remains fail-closed at the existing `/api` boundary.
- Storage and routes always take an explicit authenticated UID.
- Client-requested tools/risk do not expand authority.
- Session metadata cannot bypass tool schema, risk, confirmation, observation, recovery, or idempotency.
- Completion requires a verified runner outcome.
- Firestore browser writes to sessions and leases are denied.
- Foreign session IDs do not reveal lease availability.
- Credentials and authorization tokens are not persisted in session records.

## Bugs discovered and fixed

1. **Firestore concurrency tests were not truly atomic.** `MockFirestore.runTransaction` allowed overlapping callbacks to commit from stale snapshots. Transactions are now serialized in the test backend, and a simultaneous acquisition regression test proves one winner.
2. **Cross-user resume leaked an existence signal.** The route mapped a foreign session's failed lease acquisition to `409`, distinguishable from an unknown session. It now performs an authenticated UID-scoped lookup first and returns `404`; a regression test covers the leak.

## Files created

- `server/executionSessions.ts`
- `src/lib/execution/sessionTypes.ts`
- `src/lib/execution/sessionStore.ts`
- `src/lib/execution/firestoreSessionStore.ts`
- `src/lib/execution/localSessionStore.ts`
- `src/lib/execution/sessionCoordinator.ts`
- `src/lib/execution/sessionIndex.ts`
- `src/lib/execution/sessionCoordinator.test.ts`
- `src/lib/execution/sessionRoutes.test.ts`
- `docs/PHASE_41_ARCHITECTURE.md`
- `docs/PHASE_41_FINAL_AUDIT.md`

## Files modified for Phase 41

- `server.ts`
- `firestore.rules`
- `src/lib/persistence/mockFirestore.ts`
- `src/lib/persistence/firestoreEmulator.test.ts`
- `src/lib/firestoreRules.test.ts`

The worktree already contained extensive uncommitted Phase 33–40 changes. They were preserved and not reverted.

## Limitations

- Multi-server safety requires Firestore. The local file store is only a restart-safe single-host fallback.
- Phase 41 provides authenticated create/resume APIs, not a background cron scheduler. A caller must request resume after restart or a pause.
- Provider outage is represented by the coordinator when a runner reports it. Stable deterministic execution normally makes no provider call; provider-specific replan errors are not yet normalized into a dedicated gateway error class.
- Cancellation cannot undo or always preempt an operating-system side effect already dispatched. The executor stops between waves, and ambiguous restart state fails closed.
- A changed plan version cannot inherit the old grant. The user creates or authorizes a newly bounded session.
- Session checkpoint history is intentionally bounded to 50 entries.

## Readiness

The implemented Phase 41 scope is ready for deployment behind the existing authenticated API, provided production uses the configured Firestore backend for multi-server deployments. No AGI, consciousness, permanent consent, or unrestricted autonomous execution claim is made.

`PHASE 41 COMPLETE`
