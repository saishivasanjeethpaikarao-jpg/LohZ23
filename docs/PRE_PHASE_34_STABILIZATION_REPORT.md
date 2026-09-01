# PRE-PHASE-34 STABILIZATION REPORT

Date: 2026-08-31

Scope: stabilization of the existing Phase 33 architecture only. No Phase 34 capability work, new cognitive architecture, or duplicate-system removal was performed.

## 1. Baseline

The supplied handoff reported 53 test files and 805 tests. Direct measurement of the checked-out baseline found 53 files and 810 tests, so 810 is used as the reproducible before-count.

| Check | Before | After |
| --- | --- | --- |
| Test files | 53 | 60 |
| Tests | 810 passing | 842 passing |
| TypeScript | Passing | Passing (`tsc --noEmit`) |
| Client production build | Passing | Passing, 2,119 modules transformed |
| Server production build | Passing | Passing, 390.0 kB bundle |
| Firestore emulator | 3 passing | 5 passing |

The final client bundle is 698.23 kB minified (189.67 kB gzip). Vite reports the existing advisory for a chunk over 500 kB; this is a performance optimization item, not a correctness failure.

## 2. Bugs Found and Fixed

### 2.1 Development authentication could invent a user

**Bug:** Opt-in development authentication silently assigned `local-development` when the development identity was absent. The WebSocket path had equivalent fallback behavior.  
**Severity:** High outside a strictly isolated development environment.  
**Root cause:** The bypass treated enabling development mode as both authentication and identity.  
**Fix:** Development mode now requires an explicit, validated UID in `X-LOHZ-Dev-Uid` or `dev:<uid>`; missing or malformed identity fails closed.  
**Regression test:** `src/lib/authMiddleware.test.ts`.  
**Verification:** Missing/malformed HTTP and WebSocket identities are rejected; the authenticated route suite passes.

### 2.2 Cognitive router reported false success

**Bug:** Gateway failure, unavailable reasoning, clarification/rejection, and failed/cancelled plan outcomes could be represented as successful responses.  
**Severity:** High.  
**Root cause:** Router success represented successful dispatch rather than verified task outcome.  
**Fix:** Failure and non-execution outcomes now return `success: false`; failed/cancelled plans return `planned_execution_failed`.  
**Regression test:** `src/lib/router/router.test.ts`.  
**Verification:** Router and authenticated server contract tests pass.

### 2.3 Memory corruption and failed writes could be hidden

**Bug:** Corrupt local memory could be interpreted as an empty list and overwritten; failed backends could be reported as successful saves.  
**Severity:** High for durability.  
**Root cause:** Persistence errors were collapsed into empty/default values and boolean results were not consistently honored.  
**Fix:** Corruption and unavailable persistence fail closed; backend failure falls back only to a valid local store; all-store failure throws. Atomic local writes and ownership checks were added.  
**Regression test:** `src/lib/modelGateway/serverMemoryGateway.test.ts` and local store cases.  
**Verification:** Corruption protection, failed-save, ownership, and fallback tests pass.

### 2.4 Concurrent memory consolidation dropped or corrupted work

**Bug:** A per-user Set lock dropped concurrent consolidation requests, and local read-modify-write operations could lose updates.  
**Severity:** Medium.  
**Root cause:** Mutual exclusion was implemented as skip-on-contention rather than a queue.  
**Fix:** Per-user promise queues now serialize consolidation and local mutations; dialogue slices are copied and bounded.  
**Regression test:** Concurrent consolidation and concurrent local-add cases in `src/lib/modelGateway/serverMemoryGateway.test.ts`.  
**Verification:** Same-user concurrent requests complete without dropped slices; multi-user isolation remains green.

### 2.5 Malformed model memory transactions were trusted too far

**Bug:** Unknown UPDATE identifiers could become ADD operations, and malformed or excessive transactions were insufficiently bounded.  
**Severity:** Medium.  
**Root cause:** Model output normalization changed transaction meaning instead of validating it.  
**Fix:** Transaction count, action, category, text size, and target identifiers are validated; stale UPDATE/REMOVE operations fail closed.  
**Regression test:** Malformed and stale transaction cases in `src/lib/modelGateway/serverMemoryGateway.test.ts`.  
**Verification:** Invalid model output cannot mutate memory.

### 2.6 Gemini Live connection cleanup and message boundaries were unsafe

**Bug:** Early connection failures could leak connection counts/status intervals; oversized payloads and client-originated provider tool responses were not adequately constrained.  
**Severity:** High.  
**Root cause:** Cleanup was installed after fallible setup and tool-response traffic shared the provider channel.  
**Fix:** Idempotent cleanup is registered immediately, payloads are capped at 2 MB, upgrades accept only exact `/live`, credentials fail closed, temporal state flushes on final disconnect, and client tool responses are rejected. Gemini Live remains a transport/conversation mode with no direct tools.  
**Regression test:** `src/lib/liveSafety.test.ts`.  
**Verification:** Lifecycle, response detection, and bounded-history cases pass.

### 2.7 Temporal flush could leave a successful flush dirty

**Bug:** A mutation arriving during an in-flight successful save could remain unflushed when there was no second caller.  
**Severity:** High for restart durability.  
**Root cause:** The flush owner released its lock without draining mutations observed during the save.  
**Fix:** A successful owner flush drains newly dirty state before returning; failed persistence does not recurse indefinitely.  
**Regression test:** `src/lib/temporal/temporal.test.ts`.  
**Verification:** Mutation-during-save, concurrent flush, failure, and restart tests pass.

### 2.8 Side-effect timeouts could execute an action twice

**Bug:** A timed-out side-effecting tool could be retried even though the first action might have completed.  
**Severity:** High.  
**Root cause:** Timeout was treated as ordinary retryable failure and observation `RECHECK` could return to ACT.  
**Fix:** Side-effect timeouts are ambiguous, never automatically re-executed, and return `ambiguous_timeout` unless a verification probe proves completion. Promise-race timers are cleared.  
**Regression test:** `src/lib/execution/execution.test.ts` and `src/lib/observation/observation.test.ts`.  
**Verification:** No duplicate action is issued after ambiguous timeout.

### 2.9 Execution persistence failures could be reported as progress or success

**Bug:** Failed checkpoint, confirmation, idempotency, and transition writes were not consistently checked. Concurrent requests could also create an orphan running record.  
**Severity:** High.  
**Root cause:** Persistence booleans were treated as best-effort and the in-process plan reservation occurred after the first await.  
**Fix:** The plan is reserved synchronously; required writes are checked; unpersisted completion becomes failed/inconclusive; create-only behavior is consistent locally and in Firestore; Firestore writes use transactions.  
**Regression test:** `src/lib/execution/execution.test.ts` and `src/lib/execution/phase33.test.ts`.  
**Verification:** Initial/final checkpoint failure, concurrency, confirmation, and restart-resume tests pass.

### 2.10 Firestore embedded ownership did not match the intended boundary

**Bug:** Several user documents could contain an owner field inconsistent with the authenticated document path.  
**Severity:** High.  
**Root cause:** Rules checked document location but not every embedded ownership field; readers were also permissive.  
**Fix:** Rules now enforce `userId`/`uid`/`metadata.userId` by document type, and Firestore readers validate embedded owners defensively.  
**Regression test:** `src/lib/persistence/firestoreEmulator.test.ts`.  
**Verification:** Four emulator tests pass, including owner mismatch, restart persistence, confirmation, and two-user isolation.

### 2.11 Windows Agent URL, application, and filesystem validation diverged

**Bug:** Registry and executor validation differed; private/reserved URLs, arbitrary applications, unsafe rename basenames, and junction/symlink escapes were possible at some layers.  
**Severity:** High.  
**Root cause:** Security validation was duplicated and lexical path checks did not resolve existing ancestors.  
**Fix:** Shared public-host validation, application allowlisting, safe basenames, and realpath containment of the nearest existing ancestor are enforced by both registry and executor.  
**Regression test:** `src/windowsAgentSafety.test.ts`.  
**Verification:** Private URL, arbitrary app, traversal, and junction escape cases are rejected.

### 2.12 Windows Agent replay and lifecycle protection was incomplete

**Bug:** HTTP/WS callers could omit stable request IDs, concurrent replay could execute twice, non-loopback bridge hosts were accepted, and pending requests waited for timeouts after socket close.  
**Severity:** High.  
**Root cause:** Request identity and replay handling were transport-specific and lifecycle rejection was incomplete.  
**Fix:** One request ID crosses bridge/HTTP/WS, a bounded shared replay cache deduplicates concurrent/replayed calls, WebSocket authentication occurs during upgrade, the bridge requires loopback, and socket close rejects pending work immediately.  
**Regression test:** `src/agentSafety.test.ts`.  
**Verification:** Exactly-once replay and loopback cases pass; real screenshot replay returned the original result without a second execution.

### 2.13 Windows volume PowerShell was syntactically invalid

**Bug:** Real `getVolume`/`setVolume` scripts omitted a closing parenthesis in the base64 decode expression.  
**Severity:** Medium.  
**Root cause:** Repeated inline script prefixes drifted.  
**Fix:** A single corrected script prefix is shared by volume operations.  
**Regression test:** `src/systemTools.test.ts`.  
**Verification:** Script structure tests pass. A real run reached the Windows audio COM API and truthfully failed because this host has no audio endpoint (`0x80070490`), rather than failing in the parser.

### 2.14 Credential storage and administration were not sufficiently fail-closed

**Bug:** Concurrent writes could lose credentials, partial writes were possible, corrupt encrypted data could fall through, provider names/sizes were weakly constrained, and any authenticated user could reach global credential administration.  
**Severity:** High.  
**Root cause:** Credential storage lacked serialization/atomic replacement and administration lacked a separate UID allowlist.  
**Fix:** Strict 32-byte key validation, provider/size validation, serialized atomic writes, restrictive file modes, corruption failure, and `LOHZ_CREDENTIAL_ADMIN_UIDS` authorization were added. Token prefixes are no longer logged.  
**Regression test:** `src/credentialStore.test.ts`.  
**Verification:** Concurrent preservation, corruption, injection, and administrator authorization tests pass.

### 2.15 ModelGateway fallback, limits, and timeout behavior were misleading

**Bug:** Partial routing configuration discarded defaults, an empty provider response could be accepted, fallback failure was under-recorded, cost boundaries were off by one, and generic requests lacked a bounded timeout. NVIDIA could return empty success for unsupported capabilities.  
**Severity:** High.  
**Root cause:** Configuration was shallow-merged and provider contracts did not share strict result/timeout validation.  
**Fix:** Routing is deep-merged, prompts/results are bounded and nonempty, `>=` cost enforcement is used, provider calls have a default 30-second timeout, both failures are recorded, and unsupported NVIDIA capabilities throw.  
**Regression test:** `src/lib/modelGateway/gateway.test.ts`.  
**Verification:** Routing preservation, malformed result, fallback failure, unsupported capability, and limit tests pass.

### 2.16 Browser UI made unauthenticated or direct-agent calls

**Bug:** Credential settings and YouTube search omitted authenticated headers; BrowserAgent polled the Windows Agent directly at localhost.  
**Severity:** High at the intended trust boundary.  
**Root cause:** UI helpers bypassed the shared authenticated server boundary.  
**Fix:** UI requests obtain an ID token (or explicit development UID), and agent status is now the same-origin authenticated `/api/agent/status` endpoint.  
**Regression test:** `src/uiAuthBoundary.test.ts`.  
**Verification:** No BrowserAgent direct status polling remains; credential and browser requests retain authentication; production build passes.

### 2.17 Disabled legacy proxy and duplicate persistence adapter could regress into runtime

**Bug:** Legacy arbitrary proxy code remains physically present after an unconditional 410 response, and a second untracked Firestore plan/execution adapter was overwriting the authoritative runtime repository.  
**Severity:** Medium.  
**Root cause:** Compatibility code and duplicate wiring remained adjacent to active runtime setup.  
**Fix:** Regression tests prove both proxy routes return before fetch; duplicate adapter imports/assignments were removed from runtime wiring. The duplicate files were intentionally not deleted or formally deprecated because that requires separate approval.  
**Regression test:** `src/proxyIsolation.test.ts`; full Firestore/execution suites.  
**Verification:** `/api/proxy` and `/api/web-proxy` are isolated with 410 behavior; runtime uses the authoritative execution repository.

### 2.18 Multi-server execution lacked a distributed plan reservation

**Bug:** Independent server processes could start the same side-effecting plan before either wrote a post-action idempotency record.  
**Severity:** High.  
**Root cause:** The plan lock existed only in the engine process.  
**Fix:** Added a bounded execution-lease contract, Firestore transactional acquire/release, local atomic file leases, restart reacquisition by the same request, security rules, and production wiring for both execution engines.  
**Regression test:** `src/lib/execution/execution.test.ts` and `src/lib/persistence/firestoreEmulator.test.ts`.  
**Verification:** Two independent Firestore repository/engine instances raced the same plan; exactly one tool execution occurred and the other request was rejected.

### 2.19 NVIDIA's configured model had reached end of life

**Bug:** Real NVIDIA generation returned HTTP 410 because `meta/llama-3.1-8b-instruct` was retired on 2026-08-26.  
**Severity:** High for provider availability.  
**Root cause:** A retired model identifier was hard-coded.  
**Fix:** The default now uses the live-listed `nvidia/nemotron-3-nano-30b-a3b`, with an optional `NVIDIA_MODEL` environment override.  
**Regression test:** Existing adapter/gateway tests plus `scripts/live-provider-check.ts`.  
**Verification:** Real NVIDIA health, generation, and live fallback calls pass.

### 2.20 Gemini Live transcription used nonexistent message fields

**Bug:** Voice code read `userTurn`/model text but did not enable or consume the SDK's official input/output transcription fields, so real audio transcripts could bypass the cognitive entry simply by never being observed.  
**Severity:** High.  
**Root cause:** The Live SDK contract had drifted.  
**Fix:** Enabled `inputAudioTranscription` and `outputAudioTranscription`, and centralized extraction of `inputTranscription.text`/`outputTranscription.text`.  
**Regression test:** `src/lib/liveSafety.test.ts` and `scripts/live-voice-e2e.mjs`.  
**Verification:** Real synthesized 16 kHz speech was transcribed, entered authenticated Tier 2 reasoning, returned a cognitive result, and produced spoken audio/transcription.

### 2.21 General reasoning was incorrectly restricted to stored user context

**Bug:** The reasoning prompt told providers to answer only from bounded user context, causing valid general-knowledge questions to receive context-missing answers.  
**Severity:** Medium.  
**Root cause:** Prompt-injection protection accidentally prohibited general model knowledge.  
**Fix:** General knowledge is explicitly allowed; stored data remains untrusted and may only personalize relevant user-specific facts.  
**Regression test:** `src/lib/cognitive/cognitive.test.ts`.  
**Verification:** Real cognitive and spoken answers to a photosynthesis request were both substantive and shared multiple topic terms.

## 3. Security Findings

### Fixed

- Development HTTP/WebSocket identity fallback and untrusted request identity.
- False-success execution and ambiguous side-effect retry.
- Firestore embedded-owner mismatches and defensive read validation.
- Windows Agent private URL access, path escape, arbitrary application launch, replay, non-loopback bridge configuration, and late WebSocket authentication.
- Credential administration authorization, corrupt-store handling, atomicity, validation, file permissions, and token-prefix logging.
- Client-originated Gemini provider tool responses and oversized Live messages.
- Browser UI calls that bypassed server authentication.
- Memory corruption overwrite and malformed model-memory transactions.

### Accepted

- `npm audit --omit=dev --audit-level=high` reports six moderate transitive issues through the Firebase/Google dependency chain and no high/critical issue. The proposed force fix downgrades `firebase-admin` across a breaking major version, so it was not applied during stabilization.
- The main client chunk is larger than Vite's 500 kB advisory threshold. This affects performance, not authorization or correctness.
- Operational `console.log` calls were classified rather than blindly removed. No `@ts-ignore`, `@ts-nocheck`, `debugger`, TODO, or FIXME marker was found in production source.
- Credential-pattern scanning found only the intentional private-key redaction fixture; no tracked credential was found.

### Unresolved

- The untracked duplicate files `src/lib/persistence/firestorePlanExecStores.ts` and `src/lib/persistence/firestoreDurable.test.ts` remain in the working tree but are isolated from runtime. Removal or formal deprecation requires the separately requested approval.
- Windows Agent transport replay cache remains process-local, but authoritative plan execution is now protected by the durable pre-action plan lease and durable execution/idempotency checkpoints.

### Externally dependent

- Real Windows volume verification is blocked by the current host having no audio endpoint; the failure path was truthful.

## 4. Architecture Status

| Area | Status | Evidence / limitation |
| --- | --- | --- |
| Authentication | VERIFIED | Fail-closed HTTP/WS tests, forged/missing identity contract tests |
| Cognitive entry | VERIFIED | Typed HTTP, WS text, and transcript handlers use `handleAuthenticatedText`; legacy browser loop is unreachable |
| Router | VERIFIED | Truthful success/failure and tier contract tests |
| Cognitive core | VERIFIED | Deterministic and stubbed model boundary integration tests |
| Planner | VERIFIED | Validated plan output, policy boundary, failure/cancellation tests |
| Executor | VERIFIED | Local/restart behavior plus Firestore transactional multi-instance lease race passes |
| Observer | VERIFIED | Verified/failed/inconclusive and ambiguous timeout tests |
| Recovery | VERIFIED | Recovery exhaustion, replan, partial restart, and resume tests |
| Memory | VERIFIED | Ownership, corruption, concurrency, validation, and persistence tests |
| UserModel | VERIFIED | Owner validation and Firestore/local integration tests |
| Temporal | VERIFIED | Mutation-during-flush and restart/emulator persistence tests |
| Goals | VERIFIED | Existing goal integration and ownership suite remains green |
| Windows Agent | VERIFIED | Deterministic E2E plus real system-info/screenshot/replay; real volume failure was truthful |
| Gemini Live | VERIFIED | Real audio input, official transcription, authenticated cognitive result, output audio/transcript, and topic parity pass |
| ModelGateway | VERIFIED | Real Gemini/NVIDIA health and generation plus live fallback/cost logging pass; bounded failure tests remain green |
| Firestore | VERIFIED | Emulator transactions/restart/isolation plus deployed live rules and real Auth-user isolation pass |
| Persistence | VERIFIED | Local restart and atomic leases plus Firestore restart/transactions/distributed lease pass |

## 5. Phase 34 Gates

| Gate | Status | Evidence | Remaining blocker |
| --- | --- | --- | --- |
| Authentication | PASS | Fail-closed HTTP/WS tests plus live Firebase Auth tokens accepted by deployed rules | None |
| Cognitive path | PASS | UI text, WS text, and transcripts converge on the authenticated pipeline | None for transcript routing |
| Tool policy | PASS | Shared schemas/risk registry and Windows Agent validation tests | None known |
| Durable execution | PASS | Plans, executions, observations, confirmations, idempotency, restart, and transactional cross-server lease race pass | None |
| Temporal persistence | PASS | Flush-race regression plus restart/emulator tests | None known |
| Firestore | PASS | Emulator 5/5; rules deployed to `studio-6493633382-76662`; live own/cross-user/guest/forged-owner checks pass | None |
| Windows Agent | PASS | Stubbed full boundary and real system-info/screenshot/replay; truthful offline/audio failures | No gate blocker for the tested single-agent lifecycle |
| Voice parity | PASS | Real PCM audio produced official input transcription, Tier 2 cognitive success, 81 output audio chunks, and a topically consistent spoken transcript | None |
| Security | PASS | No known critical/high issue remains; high findings fixed; audit has moderate transitive findings only | None |
| Regression | PASS | TypeScript; 60 files/842 tests; client/server build; emulator 5/5 | None |

## 6. Performance Sanity Check

Measured local internal means from the deterministic benchmark were approximately 0.109 ms for Tier 0 routing, 0.092 ms for Tier 1, 0.084 ms for Tier 2 stub routing, and 0.037 ms for Tier 3 routing. Local persistence save mean was approximately 6.11 ms and authenticated cognitive HTTP wall mean was approximately 15.56 ms.

These are local computation/stub measurements, not user-perceived production latency. External model latency, production Firestore latency, and real network latency were not measured. Windows Agent real behavior was smoke-tested but not used to claim a general latency number.

## 7. Final Verification

- `npm run lint`: PASS.
- `npm test`: PASS, 60 files and 842 tests after all production-code changes.
- `npm run build`: PASS, client and server bundles.
- `npm run test:firestore`: PASS, 1 file and 5 tests, including independent-server lease contention.
- `npm audit --omit=dev --audit-level=high`: PASS at the requested threshold; six moderate transitive findings remain.
- `git diff --check`: PASS; only Git line-ending advisories were printed.
- Tracked secret-pattern scan: PASS; only the redaction-test fixture matched.
- Real Windows Agent: authenticated localhost system information and screenshot succeeded; replay returned the same result once; generated screenshot was removed; agent process was stopped.
- Live Firebase: rules compiled and deployed to `studio-6493633382-76662`; temporary real Auth users proved own access (200), cross-user/guest/forged-owner denial (403), and lease access (200); probe users/documents were deleted.
- Real providers: Gemini and NVIDIA health/generation pass; intentional primary failure successfully fell back to live NVIDIA and produced two cost entries.
- Real Gemini Live: synthesized 16 kHz PCM was transcribed into the authenticated Tier 2 boundary, returned a substantive cognitive result, produced 81 audio chunks, and completed with a topically consistent spoken transcript.

## 8. Concrete Phase 34 Blockers

None.

PHASE 34 READY
