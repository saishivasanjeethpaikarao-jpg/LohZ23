# Installation

Development: `npm install`, then `npm run dev`.

Desktop development: `npm run desktop:dev`.

Windows installer: `npm run package:win` creates a one-click NSIS installer in `release/`. Linux package: `npm run package:linux` creates a `.deb`; macOS package: `npm run package:mac` creates a `.dmg`. `npm run package:all` builds all configured targets on a release host. Linux and macOS builds should be built and tested on their native hosts; public releases require signing/notarization credentials and `LOHZ_SIGNED_RELEASE=true`.
