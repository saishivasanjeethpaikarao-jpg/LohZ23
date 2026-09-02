# LOHZ Architecture Reference

## Request lifecycle

The React client sends authenticated requests to the Express server’s cognitive entry. The entry builds a bounded `SituationFrame`, incorporates conversation, memory, user model, goals, temporal state, and relevant world assertions, then delegates to the existing CognitiveRouter. Planning is separate from execution. Authorized actions pass through risk/confirmation policy, the plan execution engine, observation/verification, and recovery/replan paths.

## Runtime boundaries

- Frontend: React/Vite in `src/`.
- Backend: `server.ts` and route modules in `server/`.
- Cognitive/domain services: `src/lib/`.
- Windows-only tools: `windows-agent/`, reached through `agentBridge.ts`.
- Desktop lifecycle: `desktop/` (packaging is partial).
- Persistence: Firestore adapters with local file-backed fallback stores.

## State ownership

Firebase UID is the ownership boundary for durable memories, world assertions, user model state, goals, plans, execution sessions, learning, health, and code-change proposals. Participant and speaker context is session-scoped. Retrieved content is data, never instructions.

## Providers

`ModelGateway` normalizes configured providers and records outcomes. Gemini Live remains the voice transport path; provider availability and persistence failures are surfaced as degraded states rather than hidden.
