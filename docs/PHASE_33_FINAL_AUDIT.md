# Phase 33 Final Audit

## 1. Baseline and repository inventory

- The Git repository had no commits and all product files were untracked. No history was fabricated and no user file was deleted.
- The first pre-change attempt completed 39 files / 660 tests, while eight fork workers timed out; that is recorded as an incomplete baseline, not a passing result. The historical 784/784 count was not repeated as current evidence.
- Final normal suite: **53 files / 810 tests passed**, with no failures or skips.
- Separate Firestore Emulator suite: **1 file / 3 tests passed**.
- Total distinct current tests: **813**.
- TypeScript: `tsc --noEmit` passed. The package script is named `lint`, but no ESLint/Biome rule engine exists, so TypeScript is reported as a static check rather than lint coverage.
- Production client and server bundles passed. The existing >500 kB client chunk warning remains.
- Git excludes local credentials, `.env`, build output, process/log data, the workspace-local emulator runtime, and assistant/orchestration state. Historical `.mimosa` records contain credential-shaped strings and are deliberately excluded rather than rewritten or deleted.

## 2. Architecture before

Normal typed interaction used Gemini Live while `/api/route` separately composed IntegrationPipeline and CognitiveCore. Tier 0 could call the bridge outside PlanExecutionEngine. Plans, executions, observations, and replay keys were not production Firestore-backed. The HTML proxy exposed a dangerous same-origin boundary.

## 3. Architecture after

```text
React text / authenticated API / action-bearing voice transcript
                              |
                       verified Firebase UID
                              |
                   authenticated /api/route
                              |
                     IntegrationPipeline
                              |
                       CognitiveCore
                 SituationFrame when required
                              |
                      CognitiveRouter
                  deterministic | gateway
                              |
       one-step deterministic plan | hierarchical plan
                              |
                  PlanExecutionEngine policy
                              |
              registry validation + idempotency
                              |
                 Observer / Recovery / Replan
                              |
                        Windows Agent
```

The HTTP entry assigns one request ID and propagates it through Core, Router, direct-plan persistence, execution, confirmation, and response. It returns decision, consistency, and verification state instead of dropping them.

## 4. Gemini Live decision

Gemini Live is formally a **separate Voice Companion Mode**, not transport-only. That matches the actual product: Live still generates realtime conversational audio from microphone input. Its boundary is explicit:

- no tool declarations;
- no execution, authorization, planning, verification, or persistence authority;
- unexpected provider function calls fail with `COGNITIVE_ENTRY_REQUIRED`;
- it must not claim an action ran or was saved;
- action-bearing user transcripts enter the authenticated cognitive pipeline and its result is delivered separately to the UI.

Full spoken-result parity is not claimed. The existing explicit client voice-memory trigger remains a separate UI feature pending the duplicate-system approval gate.

## 5. Authentication and canonical entry

Production without usable Firebase Admin configuration returns 503. Missing/invalid bearer tokens return 401. Only verified token UID is used; body `uid` and `userId` are ignored. Development bypass requires a non-production environment and `LOHZ_ALLOW_INSECURE_DEV_AUTH=1`.

`src/App.tsx` sends normal text to authenticated `POST /api/route`. Confirmation is resumed through authenticated `POST /api/executions/:requestId/confirm`.

## 6. Tool schema and risk authority

`windows-agent/toolRegistry.ts` is the schema and risk authority. Execution guards adapt that registry; the router no longer grants bridge access. Tier 0 creates a deterministic one-step plan and crosses the same policy, registry validation, observation, and persistence boundary as Tier 3.

Canonical contracts include:

- `clipboardWrite({ content })`;
- `renameFile({ path, newName })`;
- `setVolume({ level })` with readback `{ levelPercent, muted }`;
- file probes retain the original or computed renamed path.

## 7. Durable state and restart

`FirestoreExecutionRepository` implements PlanStore, ExecutionStore, asynchronous ObservationStore, and IdempotencyStore beneath `users/{uid}`. When Admin Firestore is healthy, server composition uses it for all four seams. `DurableExecutionRepository` remains a single-host JSON fallback only when Firestore is unavailable.

Restart behavior revalidates owner, plan version, policy, and checkpoint. Safe pending work can resume. A `running` step stops with `restart_ambiguous_side_effect` and is never blindly replayed. Confirmation state is bound to UID, request, plan, and exact version; policy is evaluated again on resume.

## 8. Temporal flushing

Temporal flushes are per UID, serialized, retried three times, and retain dirty state on failure. A per-user mutation version now prevents a successful in-flight save from clearing a newer event that arrived during that save. Concurrent flush callers drain that newer version. HTTP completion and Live-session shutdown trigger flush attempts.

## 9. Proxy and browser security

`/api/proxy` and `/api/web-proxy` return 410, isolating the old arbitrary HTML behavior by default. BrowserAgent direct frames use validated HTTP(S), sandboxing without same-origin privilege, no referrer, and strict `postMessage` origin/source/schema checks. No claim is made that arbitrary remote sites will permit iframe embedding.

## 10. Firestore evidence

Implemented and tested with Firebase CLI 15.28.2, `@firebase/rules-unit-testing` 5.0.2, Firestore Emulator 1.22.0, and a workspace-local Java 21 runtime:

- owner-only rules and unauthenticated rejection;
- forged owner-field rejection for plans/executions/observations/idempotency;
- Alice/Bob isolation;
- plan and execution persistence;
- awaiting-confirmation restart and exactly-once resume;
- idempotent replay;
- Temporal, UserModel, and Goal round trips across store recreation.

Production deployment, deployed rule version, and real production token verification remain unverified. Admin SDK access bypasses rules, so server path scoping and record-owner validation remain mandatory.

## 11. Five real request contracts

`src/lib/phase33Server.test.ts` starts an Express server with the real auth middleware seam, canonical routes, IntegrationPipeline, CognitiveCore, ContextAssembler, CognitiveRouter, HierarchicalPlanner, PlanExecutionEngine, ObservationCoordinator, Recovery/Replan, and durable stores. Only external provider/Windows operations are stubbed.

1. Tier 0: authenticated command -> central policy -> observed agent stub; UID/tool/arguments verified; zero model calls.
2. Tier 1: deterministic user-scoped response; zero tools and models.
3. Tier 2: bounded untrusted SituationFrame -> exactly one gateway call; no tools.
4. Tier 3: model-validated plan -> durable store -> execution -> observation -> transient failure recovery -> completion.
5. Confirmation: medium-risk request -> persisted wait -> authenticated reauthorization -> verified resume -> second confirmation rejected; forged UID remains isolated.

Separate tests cover safe/ambiguous restart, auth failure, malicious memory, browser messages, schema/risk, and multi-user concurrency.

## 12. Performance

Method: `npx tsx scripts/phase33-benchmark.ts`, using 500 sequential in-process routes per tier, 100 durable saves, and 50 loopback HTTP requests. Model and Windows Agent calls are stubs and excluded from the internal metrics.

- Tier 0 internal mean: 0.043 ms
- Tier 1 internal mean: 0.041 ms
- Tier 2 internal mean excluding model: 0.040 ms
- Tier 3 internal mean excluding planning/model: 0.029 ms
- Local durable save mean: 4.483 ms
- Authenticated cognitive-entry HTTP wall mean: 13.801 ms
- Real model latency: not measured
- Windows Agent round trip: not measured

## 13. Dependency security

`npm audit fix` removed the high-severity findings without using `--force`. The remaining audit result is nine moderate transitive advisories. npm's proposed forced resolution would install breaking Firebase versions, so it was not applied without a controlled dependency migration.

## 14. Credential security

`.env.example` contains placeholders only; `.env`, the AES-256-GCM credential store, key material, and service accounts are ignored. After action-time approval, the application credential was rotated to the existing `Gemini API Key 4` ending `j_Iw`, stored only in the ignored encrypted credential store, and validated with a successful read-only Gemini models request. The exposed `Gemini API Key 3` ending `Uttg` was then permanently revoked and verified absent from the provider inventory.

## 15. Duplicate-system gate

No additional duplicate system is removed or formally deprecated in this pass. Candidate cleanup—including browser CognitiveLoop-related code, alternate loops/planners, legacy Live handlers, and fail-closed compatibility stubs—remains **pending separate user approval**. Security isolation is in place, but compatibility removal is not authorized yet.

## 16. Remaining limitations and readiness

- Production Firebase deployment/auth/rules are unverified.
- Real Windows Agent round trips are unverified. Gemini credential authentication was verified with a read-only provider request; model generation latency was not benchmarked.
- Voice Companion speech can differ from the canonical cognitive result by explicit product design.
- Browser proxy functionality is disabled; direct iframe compatibility varies.
- Nine moderate transitive dependency advisories remain pending controlled upgrades.

**Items 1-9 are complete. Duplicate cleanup remains a separate approval-gated decision.**
