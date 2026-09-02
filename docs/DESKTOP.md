# LOHZ Desktop

LOHZ uses one Electron shell around the existing Vite frontend, bundled server, and platform agent. The canonical application ID is `com.lohz.desktop`, product name `LOHZ`, and version is sourced from `package.json`.

## Builds

- `npm run build:desktop` — frontend/server/desktop bundles.
- `npm run package:win` — Windows NSIS installer (x64).
- `npm run package:linux` — Linux `.deb` and AppImage targets (native Linux QA required).
- `npm run package:mac` — macOS `.dmg` target (native macOS build/signing required).

All package scripts pass `--publish never`. Use a dedicated, non-synced output directory on Windows if Electron staging files are locked in the source checkout.

## Runtime and data

The packaged app starts the bundled server and Windows Agent when available. Application files are separate from per-user data under the Electron `userData` directory. Migration is non-destructive; upgrades must not delete user data. Windows-only tools are unavailable on other platforms and must be reported by the capability model.

## Release verification

After building, run `npm run release:manifest -- <output>` and `node scripts/verify-artifact.mjs <output>`. The verifier rejects secrets, private keys, credentials, and developer paths. Firebase web API keys are public client configuration and are reported as warnings only; server credentials must never be packaged.

Native install, authentication, microphone/audio, restart, upgrade and uninstall tests are release gates and are not replaced by a cross-platform build.
