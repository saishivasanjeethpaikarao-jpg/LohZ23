import fs from "node:fs";
import path from "node:path";
const required = ["electron-builder.yml", "assets/branding/icon.svg", "dist/server.cjs", "dist-desktop/main.cjs", "dist-desktop/preload.cjs"];
const missing = required.filter((file) => !fs.existsSync(path.resolve(file)));
const signed = process.env.LOHZ_SIGNED_RELEASE === "true";
const signing = {
  windows: Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK),
  macos: Boolean(process.env.CSC_LINK || process.env.CSC_NAME) && Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID),
};
const result = {
  missing,
  signed,
  signing,
  updateConfigured: /^https:\/\//i.test(process.env.LOHZ_UPDATE_URL || ""),
  artifactRoot: process.env.LOHZ_ARTIFACT_ROOT || "release",
};
console.log(JSON.stringify(result, null, 2));
if (missing.length) process.exitCode = 1;
if (signed && (!signing.windows || !signing.macos)) {
  console.error("Signed release requires Windows certificate variables and macOS signing/notarization variables");
  process.exitCode = 1;
}
