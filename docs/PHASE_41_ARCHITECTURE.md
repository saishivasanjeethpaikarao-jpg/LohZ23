# LOHZ Phase 41 Architecture — Durable Long-Horizon Task Execution

## Scope

Phase 41 adds a durable lifecycle around the existing `PlanExecutionEngine`. It does not add a second planner, tool runner, authorization policy, observation engine, or recovery loop.

```text
authenticated request
  -> owned ready plan
  -> bounded ExecutionSession + authorization scope
  -> transactional session lease (worker + token + fencing counter)
  -> reload session under authenticated UID
  -> validate timeout and authorization
  -> validate plan ownership/version/tool scope/risk/current availability
  -> existing PlanExecutionEngine
  -> existing tool policy / observation / recovery / idempotency
  -> verified session checkpoint
```

## ExecutionSession

`ExecutionSession` is user-owned operational metadata:

- identity: `sessionId`, `userId`, `requestId`
- objective binding: bounded objective plus SHA-256 digest
- plan binding: immutable `planId` and `planVersion`
- lifecycle: created, running, paused, awaiting reauthorization, blocked, completed, failed, cancelled, or timed out
- progress: current checkpoint plus a bounded 50-checkpoint history
- authority: one bounded, expiring `SessionAuthorizationScope`
- interruption/failure: structured reason, retryability, and next action
- concurrency: monotonically increasing session version

The session stores no credentials, provider secrets, raw model prompts, or arbitrary executable code.

## Checkpoints

A checkpoint binds progress to:

- plan and plan version
- request ID
- execution record version when available
- completed step IDs
- verification status (`VERIFIED`, `FAILED`, or `INCONCLUSIVE`)
- bounded world/resume-state token
- timestamp and next action

The existing executor remains responsible for per-wave execution records and per-step idempotency. The session checkpoint summarizes long-horizon progress above those records. A session can become `completed` only when the runner returns a `VERIFIED` result.

## Safe resume

Resume is deliberately conservative:

1. Resolve the session through the authenticated UID.
2. Acquire the distributed session lease.
3. Reload the session after lease acquisition.
4. Refuse terminal or timed-out sessions.
5. Revalidate the grant source, expiry, revocation, objective digest, plan ID, and plan version.
6. Revalidate persisted plan ownership/version, exact tool set, risk ceiling, registry availability, existing execution state, and Windows Agent availability.
7. Treat changed state as `FAILED` and unobservable state as `INCONCLUSIVE`; neither executes.
8. Enter the existing observed execution engine.
9. Persist a verified, partial, or failed checkpoint using compare-and-set plus the active fencing token.

An interrupted execution record containing an ambiguous `running` side effect is still stopped by the existing Phase 33 recovery rule. It is never blindly replayed.

## Reauthorization boundaries

Authorization is plan-version and objective bound. Default grant lifetime is 15 minutes; the hard maximum is one hour. Reauthorization is required when:

- the grant expires or is revoked;
- the objective digest changes;
- the plan ID or version changes;
- required tools differ from the saved scope;
- plan risk exceeds the saved risk ceiling;
- the existing execution policy still requires explicit confirmation.

The authenticated reauthorization route re-derives tools and risk from the current owned plan. Client-supplied tool lists and risk levels are ignored. Destructive/critical tools remain rejected by the existing execution policy even if a session exists.

## Distributed locking

Production uses `FirestoreExecutionSessionStore`:

- lease acquisition is a Firestore transaction;
- one unexpired lease exists per user/session;
- every takeover increments a fencing token;
- lease ownership includes a server-generated random token;
- the coordinator renews the lease every one-third TTL;
- checkpoint writes transactionally validate the worker, lease token, fencing token, expiry, and session version;
- stale workers cannot commit after lease expiry/takeover.

`LocalExecutionSessionStore` is a restart-safe, atomic-file, single-host fallback. Its per-session guard files prevent local races, but it is not presented as a multi-server database. Multi-server deployment requires Firestore.

## Interruption behavior

- Pause: durable `paused`; next resume re-runs verification.
- Cancel: durable terminal `cancelled`, grant revoked, and the existing executor receives its cancellation flag.
- Timeout: durable terminal `timed_out`; runner is not invoked.
- Provider outage: runner may checkpoint partial work with `provider_outage` and pause.
- Windows Agent outage: pre-resume verification returns inconclusive, or an observed `agent_offline` result pauses with completed step IDs preserved.
- Persistence/lease loss: fail closed; completion is not claimed.
- Failure: durable terminal failure unless the runner explicitly reports safe partial/retryable progress.

An already-dispatched operating-system action cannot always be preempted. Cancellation is checked between executor waves, and restart recovery refuses ambiguous in-flight side effects.

## Authenticated HTTP contract

- `POST /api/execution-sessions`
- `GET /api/execution-sessions`
- `GET /api/execution-sessions/:sessionId`
- `POST /api/execution-sessions/:sessionId/resume`
- `POST /api/execution-sessions/:sessionId/reauthorize`
- `POST /api/execution-sessions/:sessionId/pause`
- `POST /api/execution-sessions/:sessionId/cancel`

All routes sit behind the existing `/api` authentication middleware. Cross-user lookup and resume return `404` without revealing foreign lease state.

## Firestore layout and rules

```text
users/{uid}/executionSessions/{sessionId}
users/{uid}/executionSessionLeases/{sessionId}
```

Owners may read session progress. Browser clients cannot write sessions, checkpoints, verification, authorization, completion, or leases. Admin-server writes remain explicitly UID-scoped.

## Bounds

- objective: 500 characters
- next action: 300 characters
- completed step IDs per checkpoint: 100
- retained checkpoints: 50
- authorization: 1 second to 1 hour
- session timeout: 1 minute to 7 days
- session lease: 1 to 60 seconds, renewed during execution

