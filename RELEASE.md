# Release checklist

- [ ] Native-host Windows, Linux, and macOS install/upgrade/uninstall tests
- [ ] Signed Windows installer
- [ ] Signed/notarized macOS build
- [ ] Linux package verification
- [ ] Migration, backup, restore, crash-recovery tests
- [ ] Full test, typecheck, build, and security suite
- [ ] HTTPS update feed and signature verification

The repository is not public-release-ready until every checked gate is evidenced in the Phase 49 audit.

## Signing variables

Signing is opt-in and credential-safe. CI/release hosts must provide `CSC_LINK` (or `WIN_CSC_LINK`) and `CSC_KEY_PASSWORD` for Windows. macOS signing/notarization additionally requires `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` (or an approved `CSC_LINK`). Never commit certificates, private keys, passwords, or service-account files. Without these variables artifacts are explicitly `UNSIGNED`.

## Artifact verification

Build with `--publish never`, then run `npm run release:manifest -- <artifact-directory>` and `node scripts/verify-artifact.mjs <artifact-directory>`. The verifier rejects private keys, secret tokens, credentials, and development-machine paths; Firebase web API keys are reported only as public-client warnings. On Windows, use a dedicated output directory outside synced/source folders if staging-file locks cause `EBUSY`/`EPERM`.
