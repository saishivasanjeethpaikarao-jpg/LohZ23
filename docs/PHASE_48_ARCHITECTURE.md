# Phase 48 Architecture

One Electron main process owns lifecycle and starts the existing production server plus the Windows Agent only on Windows. The renderer remains the existing React application. Preload exposes capabilities, backup/restore, and update status through context-isolated IPC. Mutable state uses `LOHZ_DATA_DIR`; packaged assets use `LOHZ_APP_ROOT`. Linux and macOS report platform-specific capabilities rather than exposing Windows tools.
