import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
let javaHome = process.env.JAVA_HOME;
if (!javaHome) {
  for (const version of ["temurin21"]) {
    const localRoot = path.join(root, ".tools", version);
    const local = fs.existsSync(localRoot)
      ? fs.readdirSync(localRoot, { withFileTypes: true }).find((entry) => entry.isDirectory())
      : null;
    if (local) { javaHome = path.join(localRoot, local.name); break; }
  }
}
if (!javaHome || !fs.existsSync(path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java"))) {
  console.error("Firestore emulator tests require Java 21. Set JAVA_HOME or place a JRE under .tools/temurin21/.");
  process.exit(1);
}

const firebaseCli = path.join(root, "node_modules", "firebase-tools", "lib", "bin", "firebase.js");
const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  XDG_CONFIG_HOME: path.join(root, ".tools", "config"),
  XDG_CACHE_HOME: path.join(root, ".tools", "cache"),
  FIREBASE_CLI_TELEMETRY_OPTOUT: "1",
  CI: "1",
  // Native Windows JDKs can receive an MSIX-injected temp path that breaks
  // AF_UNIX selector pipes. Empty values make the JDK choose its safe default.
  TEMP: "",
  TMP: "",
  TMPDIR: "",
  JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ?? ""} -Djava.net.preferIPv4Stack=true -Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.WindowsSelectorProvider`.trim(),
};
const result = spawnSync(process.execPath, [
  firebaseCli,
  "emulators:exec",
  "--project", "demo-lohz-phase33",
  "--only", "firestore",
  "npm run test:firestore:spec",
], { cwd: root, env, stdio: "inherit" });

process.exit(result.status ?? 1);
