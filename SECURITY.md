# LOHZ Security

- API routes fail closed when authentication cannot be verified.
- The Windows Agent is loopback-only and token-authenticated.
- Electron uses sandboxing, context isolation, disabled Node integration, and a narrow preload API.
- Participant speech and retrieved memory are untrusted data; they cannot authorize tools.
- Credentials use AES-256-GCM; desktop builds use OS `safeStorage` when available.
- Updates are disabled unless the build is signed and the update URL is HTTPS. Unsigned local packages are not release artifacts.
- No raw audio, biometric voiceprints, or silent identity inference are persisted by the productization layer.
