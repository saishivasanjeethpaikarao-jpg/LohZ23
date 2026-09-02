# Phase 49 Architecture

Branding is vector-first and shared by browser, installer, and desktop icon surfaces. electron-builder defines NSIS, deb, and dmg targets. Updates are opt-in only for signed HTTPS releases, with backup before installation. Release verification is explicit and fails when required bundles or signing credentials are missing.
