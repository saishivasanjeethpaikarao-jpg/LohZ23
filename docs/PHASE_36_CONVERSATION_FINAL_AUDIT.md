# LOHZ Phase 36 Final Audit

Audit date: 2026-08-31 (Asia/Calcutta)

Final declaration: **PHASE 36 NOT COMPLETE**

The safe multi-person foundation is implemented and locally verified. Phase 36 cannot truthfully be marked complete because the actual production voice stack supplies no diarization or overlap metadata, so it cannot yet distinguish real Speaker A from Speaker B or prove real Gemini Live audio/result parity. The fallback is safe and functional: explicit group mode attributes untagged voice to `unknown_participant`, prevents durable user attribution and account authorization, and remains conversational when LOHZ is addressed.

## 1. Baseline and final gates

| Gate | Result | Evidence |
|---|---:|---|
| Baseline tests before Phase 36 edits | VERIFIED: 61 files / 856 tests passed | `npm test`, 184.97 s |
| New test files | 2 | `conversation.test.ts`, `securityIntegration.test.ts` |
| New tests | 27 | Phase 36 delta from baseline |
| Final full regression | VERIFIED: 63 files / 883 tests passed | `npm test` after final implementation |
| TypeScript | VERIFIED: pass | `npx tsc --noEmit` |
| Frontend build | VERIFIED: pass | Vite, 2,119 modules |
| Server build | VERIFIED: pass | esbuild `dist/server.cjs` |
| ESLint | LIMITATION: not installed | No ESLint dependency/config; repository `lint` script is only `tsc --noEmit` |

The build emits the existing chunk-size warning: the main frontend JavaScript bundle is approximately 700 kB minified. It is not a Phase 36 functional failure but remains performance debt.

## 2. Architecture audit findings

1. `VERIFIED` Audio enters through `src/lib/audio.ts` as one browser-mixed mono microphone stream and is sent as 16 kHz PCM through authenticated `/live`.
2. `VERIFIED` Gemini Live produces input/output transcription in `server.ts`; the old implementation processed every chunk as a complete user request.
3. `VERIFIED` Installed `@google/genai` 2.8.0 exposes only transcript text/finality/language. It provides no speaker/channel/overlap contract.
4. `VERIFIED` Transcript turns were plain `{role,text}` entries in server memory history and the UI.
5. `VERIFIED` Memory extraction received the whole voice dialogue with every human turn attributed as the authenticated user.
6. `VERIFIED` Gemini Live is transport/conversation mode; provider function tools are disabled and cognitive results travel separately.
7. `VERIFIED` The authenticated UID originates at Firebase WebSocket/HTTP authentication and is propagated to the one IntegrationPipeline/CognitiveCore/router path.
8. `VERIFIED` durable account systems are user-scoped; Phase 36 speaker state is correctly session-scoped.

## 3. Speaker and conversation architecture

`IMPLEMENTED` New bounded types model `SpeakerId`, `ConversationSpeaker`, `SpeakerTurn`, confidence provenance, and `ConversationParticipantState`.

`IMPLEMENTED` A `ConversationSession` exists per authenticated WebSocket. It serializes updates, retains at most eight speakers/sixteen turns, returns defensive snapshots, and disappears on disconnect/restart.

`IMPLEMENTED` Typed input remains `primary_user`. Single-person voice mode preserves compatibility. Untagged group voice becomes `unknown_participant`. Low-confidence tags become unknown. Provider tags, if a future provider supplies them, become sanitized session IDs only.

`DORMANT` Session display-name binding is implemented as an explicit API but is not automatically inferred or permanently stored. The current UI does not yet parse “this is Rahul” into a label.

## 4. Voice integration and response behavior

`IMPLEMENTED` Partial/cumulative transcripts are aggregated until `finished` or `turnComplete`; duplicates are removed and provider metadata survives the final boundary.

`IMPLEMENTED` Group output is buffered in a bounded in-memory gate and released only after the response decision. Human-human conversation is suppressed; explicit LOHZ address is allowed; ambiguity/overlap produces a clarification result.

`VERIFIED` Single-person behavior remains the direct streaming path.

`PARTIAL` Suppression occurs after Gemini has generated output, so it prevents playback/interruption but does not avoid that provider generation cost.

`PARTIAL` The clarification response from the deterministic overlap/ambiguity gate is visible in cognitive UI results; it is not separately converted to audio.

`LIMITATION` Real human-human overlap cannot be detected from the current mixed mono stream/provider metadata. Gemini's `interrupted` flag is assistant barge-in handling, not multi-human overlap diarization.

## 5. Cognitive integration

`IMPLEMENTED` Speaker state flows through the existing authenticated entry:

```text
transcript -> ConversationSession -> IntegrationPipeline -> CognitiveCore
           -> SituationFrame -> CognitiveRouter -> existing authorization/execution
```

No second cognitive core, planner, memory system, tool system, or voice system was created.

`IMPLEMENTED` SituationFrame receives at most twelve recent speaker excerpts (400 characters each), participant count, active speaker, confidence provenance, overlap, and addressing state.

`VERIFIED` Participant context is explicitly fenced as untrusted prompt data. A participant request cannot turn conversation content into model instructions or execution authority.

## 6. Memory attribution and UserModel protection

`IMPLEMENTED` Server memory lines carry `primary_user`, `participant`, or `session` ownership. Participant/session turns and their corresponding assistant exchange are removed before the pre-gate, model, store, UserModel, or goal integration.

`IMPLEMENTED` Participant-only slices return before a storage read or model call.

`IMPLEMENTED` Browser auto-memory capture is disabled for participant/unknown voice turns.

`VERIFIED` Tests cover participant preferences, projects, personal facts, and injected instructions not reaching primary-user memory. Tests also show an explicit authenticated-user “remember” statement can proceed through normal policy.

## 7. Authorization and security

`IMPLEMENTED` `speakerAuthorization` is request metadata, not authentication. The HTTP cognitive entry ignores client speaker claims and remains primary-user only.

`IMPLEMENTED` The authoritative router rejects participant/unknown Tier 0 tools, Tier 3 planning/execution, memory queries, and private-context queries before executor/provider reads.

`VERIFIED` Tests cover participant tool denial, confirmation bypass prevention, private-context denial, prompt fencing, cross-user/session isolation, and no executor call on a blocked request.

`VERIFIED` Existing authentication, risk policy, durable execution, idempotency, confirmation, observation, verification, recovery, and per-user persistence wiring were not replaced or weakened.

## 8. Persistence and privacy

`IMPLEMENTED` Speaker/session state is deliberately not restart-persistent. This avoids accumulating unknown identities and unconfirmed participant information.

`IMPLEMENTED` Phase 36 stores no input audio, voice embedding, voiceprint, biometric profile, inferred name, age, gender, ethnicity, religion, health information, or relationship.

`IMPLEMENTED` The response gate temporarily buffers bounded provider-output audio in process memory only; it is discarded after the turn and is not used for identification.

`LIMITATION` There is not yet a user-facing participant-data deletion action because participant data has no durable store; disconnecting the voice session deletes it.

## 9. Performance measurement

Command: `npm run benchmark:phase36`

Workload: 10,000 iterations of speaker normalization, two transcript chunks, bounded session update, and response decision.

| Measurement | Result |
|---|---:|
| median local metadata latency | 0.0122 ms |
| p95 | 0.0394 ms |
| p99 | 0.0797 ms |
| process CPU during workload | 156.00 ms user / 47.00 ms system |
| observed heap delta | 1,094,704 bytes |
| retained state | 16 turns / 4 speakers |
| added model calls | 0 |
| local diarization CPU | none; no diarizer installed |

These are synthetic Node measurements from this machine. Heap delta includes runtime noise. They are not microphone-to-response latency, provider latency, or a real-time guarantee.

## 10. Bugs discovered and fixed

1. `FIXED` Partial transcription chunks were independently treated as complete cognitive requests, causing duplicate actions/memory candidates. Added final-turn aggregation and regression tests.
2. `FIXED` A `turnComplete` payload could be handled before transcript text on the same message, producing missing/out-of-order history. Reordered provider event handling and serialized turns.
3. `FIXED` Every voice speaker was attributed to the account owner, allowing participant facts into memory/UserModel. Added ownership filtering at server and client boundaries.
4. `FIXED` Participant speech could reach the authenticated cognitive executor as the owner. Added authoritative speaker-aware router rejection.
5. `FIXED` Participant reasoning could load private owner memories/UserModel/goals/world/temporal context. Non-primary assembly now skips those providers.
6. `FIXED` Gemini could start speaking before the deterministic response gate completed. Added bounded ephemeral output buffering and suppression.
7. `FIXED` Model transcript callbacks were not delivered consistently by the browser audio session. Finalized user metadata and model captions now share the extended callback.
8. `FIXED` Transcript UI labeled every human as `YOU`. It now distinguishes `YOU`, `GUEST`, participant labels, and `LOHZ`.

Every listed bug has a focused regression test at its pure boundary or end-to-end cognitive boundary.

## 11. Test coverage added

- one/two/three simulated speaker states, unknown and low confidence;
- repeated speakers, speaker changes, malformed metadata, concurrent ordering;
- bounded state, snapshot isolation, restart cleanup;
- partial/cumulative/final transcript behavior and deduplication;
- overlapping-speech uncertainty behavior;
- participant-to-user, participant-to-LOHZ, user-to-LOHZ, silence, explicit and ambiguous address;
- provider output allow/suppress/overflow behavior;
- participant memory/UserModel/project protection and explicit primary-user promotion;
- participant tool/private-context/confirmation denial;
- prompt fencing and bounded SituationFrame integration;
- two-user/two-session isolation;
- realistic conversation-to-CognitiveCore result and participant tool-block flows.

## 12. Files created

- `src/lib/conversation/types.ts`
- `src/lib/conversation/speakerNormalization.ts`
- `src/lib/conversation/session.ts`
- `src/lib/conversation/transcriptAccumulator.ts`
- `src/lib/conversation/responseEligibility.ts`
- `src/lib/conversation/providerOutputGate.ts`
- `src/lib/conversation/index.ts`
- `src/lib/conversation/conversation.test.ts`
- `src/lib/conversation/securityIntegration.test.ts`
- `scripts/phase36-benchmark.ts`
- `docs/PHASE_36_ARCHITECTURE.md`
- `docs/PHASE_36_FINAL_AUDIT.md`

## 13. Files modified

- `server.ts`
- `server/liveSafety.ts`
- `server_memory.ts`
- `package.json`
- `src/App.tsx`
- `src/components/TranscriptionPanel.tsx`
- `src/hooks/useVoiceMemory.ts`
- `src/lib/audio.ts`
- `src/lib/cognitive/types.ts`
- `src/lib/cognitive/situationFrame.ts`
- `src/lib/cognitive/contextAssembler.ts`
- `src/lib/cognitive/cognitiveCore.ts`
- `src/lib/cognitive/cognitiveGuards.ts`
- `src/lib/integration/pipeline.ts`
- `src/lib/router/cognitiveRouter.ts`

## 14. Remaining limitations and Phase 37 readiness

- `LIMITATION` No real A/B/C diarization is available from the installed production provider.
- `LIMITATION` No reliable human-human overlap signal is available.
- `PARTIAL` Real Gemini Live audio, interruption, and group-response parity were not exercised with a paid/live key in this run; no provider credits were spent.
- `PARTIAL` Group response suppression prevents playback but not upstream Gemini generation cost.
- `DORMANT` Future provider speaker metadata normalization is tested only with explicit simulation.
- `DORMANT` Session name binding exists but has no automatic natural-language introduction handler.

**Phase 37 is not ready** under the prompt's strict completion rule. To close Phase 36, select and separately validate a production diarization source (provider-native preferred), measure Windows latency/CPU/licensing/privacy behavior, and run a real Gemini Live two/three-speaker and overlap test. Until then the safe unknown-participant fallback should remain the production default for group mode.

## Final

**PHASE 36 NOT COMPLETE**
