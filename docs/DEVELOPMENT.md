# Development Guide

## Setup

```bash
npm install
Copy-Item .env.example .env
npm run dev
```

The default development server is Vite plus the Express server. Firebase Admin is intentionally fail-closed unless local development authentication is explicitly enabled.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run agent` | Windows Agent |
| `npm run lint` | TypeScript check |
| `npm test -- --pool=forks --maxWorkers=1` | Full deterministic test run |
| `npm run test:firestore` | Firestore emulator rules/integration tests |
| `npm run build` | Production web and server build |
| `npm run build:desktop` | Desktop process bundles |
| `npm run release:verify` | Release metadata and signing-policy check |

## Contribution rules

Keep the authenticated cognitive entry as the single authority boundary. Preserve UID isolation, prompt-injection fencing, confirmation, verification, and fail-closed behavior. Every bug fix needs a regression test. Do not commit secrets, generated output, local `data/`, or credentials.
