# LOHZ Phase 36 Architecture

Status vocabulary: `IMPLEMENTED`, `VERIFIED`, `PARTIAL`, `DORMANT`, `LIMITATION`.

## Verified baseline and provider boundary

- `VERIFIED` Browser audio is one mixed, mono microphone stream. The client resamples it to 16 kHz PCM and sends it through the authenticated `/live` WebSocket.
- `VERIFIED` The installed `@google/genai` runtime is 2.8.0. Its `Transcription` contract exposes `text`, `finished`, and `languageCode`; it does not expose a speaker tag, channel, diarization confidence, or overlap flag.
- `LIMITATION` Production Gemini Live therefore cannot distinguish real Friend A from Friend B in this repository. No pitch heuristic, voiceprint, facial recognition, or fake diarization was added.
- `IMPLEMENTED` A defensive normalizer accepts future/provider-supplied speaker metadata when present. Tests using speaker tags are explicitly simulations, not claims about the installed provider.

## Identity and session boundaries

`authenticatedUserId` and `speakerId` are separate concepts.

```text
Firebase token -> authenticatedUserId -> account authorization boundary

Conversation session -> speakerId -> conversation attribution only
```

The session-local speaker vocabulary is:

- `primary_user`: only when attribution is explicit and trustworthy (typed input or explicit single-person mode).
- `speaker_<provider-tag>`: a normalized, non-biometric session tag when a provider supplies usable metadata.
- `unknown_participant`: the fail-safe for untagged or low-confidence group audio.

`ConversationSession` is created inside each authenticated WebSocket connection. It is not global, is bounded to eight speaker records and sixteen recent turns, serializes concurrent updates, and is discarded on disconnect/restart. Unknown participants, voiceprints, and participant personal data are not written to Firestore or the memory store.

## Request lifecycle

```text
mixed microphone PCM
  -> authenticated /live WebSocket
  -> Gemini Live transcription chunks
  -> TranscriptAccumulator (wait for finished/turnComplete, deduplicate)
  -> ConversationSession (bounded speaker turn)
  -> response eligibility gate
       -> silent: suppress buffered provider audio
       -> clarify: suppress provider audio, return uncertainty message
       -> respond: release buffered provider audio
  -> IntegrationPipeline.handleAuthenticatedText
  -> CognitiveCore
  -> bounded SituationFrame conversation context
  -> CognitiveRouter
  -> authenticated authorization/execution boundary
```

Typed UI input remains `primary_user`, calls the same `IntegrationPipeline` through `/api/route`, and does not accept a client-supplied speaker authorization override.

## Transcript and output ordering

`IMPLEMENTED` `TranscriptAccumulator` handles incremental and cumulative provider text, waits for finality, suppresses duplicate final turns, and retains metadata until `turnComplete` when needed.

`IMPLEMENTED` Provider events are processed in this order:

1. input/output transcript payloads;
2. transcript finalization and ordered conversation update;
3. `turnComplete` snapshot;
4. asynchronous memory extraction.

This fixes the earlier race where partial/duplicated turns were sent independently to cognition and where a final transcript on the same provider message as `turnComplete` could be absent from the memory snapshot.

`IMPLEMENTED` In group mode, provider output audio and captions are held by a bounded, ephemeral `ProviderOutputGate` until response eligibility is known. The bound is 256 audio chunks, 8,000,000 base64 characters, and 64 caption chunks. Overflow suppresses output. The buffer is never persisted and is provider output, not a biometric/input recording.

## Response eligibility

The deterministic gate considers:

- explicit `LOHZ` / `Hey LOHZ` address;
- a small bounded set of contextual invitations such as “what do you think?”;
- a primary-user question that is ambiguous in a group;
- human-human question/answer turns;
- provider-reported overlap, if such metadata becomes available.

Single-person mode preserves existing always-responsive behavior. Group discussion that is not addressed to LOHZ is suppressed. The gate changes response eligibility only; it never grants tool authority.

`PARTIAL` Gemini still performs its provider-side generation before the server can suppress playback, so silence saves neither a provider turn nor its provider-side compute. Clarification produced by the deterministic gate is currently a UI cognitive response, not separately synthesized speech.

## Cognitive context

`SituationFrame.conversationContext` contains only bounded metadata and excerpts:

- mode and participant count;
- active session speaker and role;
- at most twelve recent speaker turns, each clipped to 400 characters;
- confidence value, level, and provenance kind;
- overlap and addressing state.

Participant context is rendered inside the existing `UNTRUSTED DATA` fence with an explicit statement that participant speech is data, not authorization. When the current speaker is not the primary user, `ContextAssembler` does not load account memories, UserModel, goals, temporal events, or world assertions.

## Memory and UserModel ownership

```text
primary_user turn -> normal durable-memory eligibility
participant turn  -> bounded session conversation only
unknown turn      -> bounded session conversation only
```

`filterMemoryEligibleDialogue` removes participant/session turns and their assistant exchange before extraction. Participant-only slices return before loading storage or calling a model. `useVoiceMemory` also receives an explicit eligibility flag, preventing the browser-side “remember this” shortcut from saving participant speech.

UserModel and goal updates remain downstream of durable primary-user memory outcomes. A participant cannot modify them. An explicit primary-user statement such as “remember that Rahul is my friend” continues through the normal memory policy; merely introducing Rahul creates no permanent contact or voice identity.

## Authorization

`speakerAuthorization` travels as request metadata from the voice session through `IntegrationPipeline` and `CognitiveCore` to `CognitiveRouter`.

For `participant` or `unknown`, the authoritative router rejects:

- every Tier 0 tool action;
- every Tier 3 planning/execution request;
- account memory queries;
- private context queries.

The executor is not invoked. Existing Firebase authentication, risk policy, confirmation, durable execution, verification, recovery, and ownership checks remain unchanged. Speaker identity can never confirm an execution.

## Confidence semantics

- `explicit_session`: explicit UI/session attribution; value 1.0.
- `provider_calibrated`: provider asserts calibrated confidence; high >= 0.8, medium >= 0.5, otherwise unknown.
- `provider_unscaled`: a provider supplies a value/tag without calibration. It is a heuristic score, not a probability.
- `fallback`: no useful metadata; unknown participant.

Malformed metadata is sanitized and bounded. Low confidence becomes unknown.

## Persistence and privacy

- Session ID, speaker records, recent turns, display labels, and output buffers: memory only; deleted on WebSocket teardown/process restart.
- Durable primary-user memories: existing user-scoped MemoryStore/Firestore path only after attribution filtering.
- Raw input audio: streamed to Gemini; not stored by Phase 36.
- Raw voice embeddings/voiceprints: not created.
- Sensitive attributes: not inferred.
- Participant records: not automatically created as contacts or UserModel attributes.

## UI

The existing control bar now has an accessible native group-mode button with `aria-pressed` and a text label (`1 PERSON`, `GROUP`, or a detected bounded count). Transcript rows render `YOU`, `GUEST`, a session display label, or `LOHZ`. No unrelated redesign was performed.

## Production capability matrix

| Capability | Status | Production truth |
|---|---|---|
| Primary vs non-owner privacy boundary | IMPLEMENTED | Explicit single/group mode; group fallback is non-owner/unknown |
| Multiple provider speaker tags | DORMANT | Normalizer exists; installed Gemini Live does not supply tags |
| A/B/C real-voice diarization | LIMITATION | Not available in the current production stack |
| Human-human overlap metadata | DORMANT | Honored if supplied; current provider does not supply it |
| Stay silent when not addressed | IMPLEMENTED | Provider playback/captions are deterministically suppressed |
| Natural provider turn-taking/barge-in | PARTIAL | Gemini-native interruption remains; no local diarizer was introduced |
| Participant memory isolation | IMPLEMENTED | Server and browser gates plus tests |
| Participant tool denial | IMPLEMENTED | Authoritative router rejection plus existing execution boundary |

