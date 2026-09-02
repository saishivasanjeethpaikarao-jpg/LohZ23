# Release Readiness

The repository has a partial Electron desktop shell and electron-builder metadata for NSIS, deb, and dmg targets. A public release requires native-host install/upgrade/uninstall testing, signing/notarization, secure update configuration, migration/rollback evidence, and dependency advisory review.

Current evidence is recorded in [PHASE_49R_FINAL_AUDIT.md](PHASE_49R_FINAL_AUDIT.md). Do not label a build release-ready until those gates are evidenced.
