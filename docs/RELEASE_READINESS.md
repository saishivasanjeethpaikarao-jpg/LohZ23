# LOHZ Release Readiness

The current release decision is recorded in [PHASE_49R_FINAL_AUDIT.md](PHASE_49R_FINAL_AUDIT.md). The repository is **not release-ready** while signing, native QA, production dependency advisories, full regression evidence, or reproducible installer validation remain incomplete.

Platform labels are evidence-based:

- Windows: installer build verified in an isolated output directory; native clean-install lifecycle pending.
- Linux: `.deb` and AppImage configuration present; native QA pending.
- macOS: `.app`/`.dmg` configuration present; native build, signing and notarization required.

No unsigned artifact may be described as production-ready. No GitHub Release should be published until every mandatory gate is green.
