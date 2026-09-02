# LOHZ Architecture

LOHZ is a React/Vite interface backed by an authenticated Express cognitive entry. The desktop build wraps the same server and Windows Agent with one Electron shell. The shell starts the loopback server, optionally starts the Windows-only agent, exposes only narrow context-isolated IPC, and stores mutable state under the OS user-data directory.

Request flow: UI → authenticated `/api` → CognitiveCore/router/planner → authorization and confirmation → execution → observation/verification → memory/world/self-model updates.

The packaged bundle is read-only. `LOHZ_DATA_DIR` contains credentials, memories, health, sessions, logs, backups, and migration metadata. `LOHZ_APP_ROOT` identifies packaged assets and source inspection boundaries.
