# Phase 33 Architecture and Migration Record

## Repository baseline

The repository began with a `.git` directory but no commits. Product source, tests, configuration, and documentation were all untracked. No user file was deleted and no history was invented.

The baseline excludes:

- `.env*` except sanitized `.env.example`;
- `.credentials.enc`, `.credential_store_key`, service accounts;
- `node_modules`, `dist`, coverage, logs, PIDs, scratch files, and local `data`;
- the workspace-local `.tools` emulator runtime/cache;
- `.agents`, `.claude`, `.claude-flow`, `.mimosa`, `.swarm`, `hive`, rosters, queues, and backups.

The assistant/orchestration directories are local operating state, not LOHZ product source. Some historical `.mimosa` records contain credential-shaped strings, which is an additional reason they must not enter Git. They were preserved on disk.

## Authoritative cognitive path

```text
React text ─────────────────────────┐
Authenticated API ──────────────────┼── verified UID + request ID
Action-bearing voice transcript ────┘                 |
                                             POST /api/route
                                                      |
                                             IntegrationPipeline
                                                      |
                                               CognitiveCore
                                              SituationFrame
                                                      |
                                              CognitiveRouter
                                      deterministic ──┴── gateway
                                                      |
                                 one-step plan / hierarchical plan
                                                      |
                                           PlanExecutionEngine
                                                      |
                                registry schema + policy + idempotency
                                                      |
                                      Observer / Recovery / Replan
                                                      |
                                              Windows Agent
```

The authenticated HTTP entry owns request identity. Core and Router accept the same request ID, and Tier 0's direct-plan ID, execution checkpoint, confirmation endpoint, and result refer to it consistently. The response exposes structured decision, lifecycle, model-call count, consistency, and verification status.

## Voice product boundary

Gemini Live is a separate **Voice Companion Mode**. It is not described as transport-only because it genuinely creates realtime companion speech. It has no tools or durable/execution authority. Unexpected function calls fail closed. Action-bearing transcripts are evaluated through the canonical pipeline, and the UI receives a separate `voice_cognitive_result`.

Consequences:

- Live speech is conversational, not proof of execution.
- Only the cognitive result may claim a tool, plan, authorization, confirmation, persistence, or verification outcome.
- Full audio rendering of the canonical result is future product work, not claimed here.
- The existing explicit client voice-memory trigger is retained until the separate duplicate-system gate.

## Authentication

Firebase bearer verification is authoritative. Production configuration failure returns 503. Missing or invalid bearer credentials return 401. Request-body identity is ignored. The development header works only when both the environment is non-production and `LOHZ_ALLOW_INSECURE_DEV_AUTH=1` is explicitly set.

## Tool and execution authority

`windows-agent/toolRegistry.ts` owns tool name, schema, validation, risk, timeout, and execution handler. `src/lib/execution/guards.ts` adapts that data and adds the closed destructive deny-list.

`createAuthorizedToolExecutor` converts Tier 0 into a one-step plan. The router therefore never calls AgentBridge directly. Tier 0 and Tier 3 share policy evaluation, argument validation, idempotency, observation, recovery, and persistence.

## Persistence layout

When Admin Firestore is healthy, these seams use `FirestoreExecutionRepository`. When it is unavailable, `DurableExecutionRepository` is an explicit single-host fallback under ignored `data/phase33`.

| Resource | Firestore path | Owner field | Rule behavior | Admin/server behavior |
|---|---|---|---|---|
| Profile | `users/{uid}` | `uid` | owner read/delete; owner-field create/update | explicit UID |
| Preferences | `users/{uid}/preferences/_root` | internal user ID | owner only | explicit UID |
| Memories | `users/{uid}/memories/{id}` | `metadata.userId` | owner path | store validates owner |
| Cognitive state | `users/{uid}/cognitiveState/_root` | `uid` | owner only | store validates owner |
| UserModel | `users/{uid}/userModel/_root` | `uid` | owner only | store validates owner |
| Temporal | `users/{uid}/temporal/_root` | `uid` | owner only | store validates owner |
| Goals | `users/{uid}/goals/{id}` | path owner | owner only | explicit UID |
| Plans | `users/{uid}/plans/{planId}` | `userId` | matching owner field required | repository validates owner |
| Executions | `users/{uid}/executions/{requestId}` | `uid` | matching owner field required | repository validates owner |
| Observations | `users/{uid}/observations/{requestId}` | `uid` | matching owner field required | bounded transactional append |
| Idempotency | `users/{uid}/idempotency/{encodedKey}` | `uid` | matching owner field required | original key verified on read |

The Admin SDK bypasses Firestore rules. Server-side path scoping and record-owner checks are therefore part of the security boundary, not redundant validation.

## Restart and confirmation

Checkpoint recovery loads user executions, validates ownership and exact plan version, re-evaluates current policy, and resumes only pending work without an ambiguous running side effect. Ambiguous work fails closed. Medium/high-risk work persists `awaiting_confirmation`; resume reloads the owned plan, checks the exact version, reauthorizes, then executes. Replays return stored state.

## Temporal lifecycle

TemporalService stores bounded per-user rings and snapshots. Flushes are per UID, retrying and failure-aware. Mutation versions ensure an event arriving during an in-flight save remains dirty rather than being erased by the older save's completion. A concurrent flush waits and persists the new version.

## Web boundary

The legacy HTML proxy endpoints are isolated with HTTP 410. Direct BrowserAgent frames accept validated HTTP(S) only, run sandboxed without same-origin privilege, omit referrers, and accept navigation messages only from the exact iframe window and LOHZ origin with a strict schema.

## Firestore emulator contract

`npm run test:firestore` selects a Java 21 runtime from `JAVA_HOME` or ignored `.tools/temurin21`, scrubs incompatible MSIX temp variables, starts a demo-project Firestore emulator, loads `firestore.rules`, runs rules and restart tests, then shuts the emulator down. It never contacts production Firestore.

## Duplicate-system approval gate

Candidate overlapping systems are intentionally not given a new REMOVE/DEPRECATE decision here. Their production reachability and compatibility imports have been audited, but final classification/removal is held for the separate approval required after architecture, security, persistence, emulator, and E2E validation.
