import fs from "node:fs";
import path from "node:path";
import { extractFile, listPackage } from "@electron/asar";

const root = path.resolve(process.argv[2] || process.env.LOHZ_ARTIFACT_ROOT || "release");
const findings = [];
const warnings = [];
const textExtensions = new Set([".js", ".cjs", ".mjs", ".json", ".yml", ".yaml", ".txt", ".html", ".css", ".map", ".svg"]);
const forbidden = [
  /(?:[A-Z]:[\\/](?:Users|Kaveri Files|D:))/i,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i,
  /sk-[A-Za-z0-9_-]{20,}/,
];
const publicFirebaseKey = /AIza[0-9A-Za-z_-]{20,}/;

function scanDirectory(dir, label = "") {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const absolute = path.join(dir, entry.name);
    const relative = `${label}${entry.name}`;
    if (entry.isDirectory()) scanDirectory(absolute, `${relative}/`);
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
      const size = fs.statSync(absolute).size;
      if (size > 25 * 1024 * 1024) continue;
      const content = fs.readFileSync(absolute, "utf8");
      for (const pattern of forbidden) if (pattern.test(content)) findings.push(relative);
      if (publicFirebaseKey.test(content)) warnings.push({ path: relative, type: "firebase-web-api-key" });
    }
    if (/(?:^|[\\/])(?:\.env(?:\.|$)|firebase-service-account\.json|credentials?\.enc|credential_store_key|\.agent-token)$/i.test(relative)) {
      findings.push(relative);
    }
  }
}

const packageRoot = fs.existsSync(path.join(root, "win-unpacked")) ? path.join(root, "win-unpacked") : root;
scanDirectory(packageRoot);
const asarFiles = [];
function findAsar(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) findAsar(absolute);
    else if (entry.isFile() && entry.name === "app.asar") asarFiles.push(absolute);
  }
}
findAsar(root);
for (const asar of asarFiles) {
  for (const entry of listPackage(asar)) {
    const normalized = entry.replaceAll("\\", "/").replace(/^\//, "");
    if (!(normalized.startsWith("dist/") || normalized.startsWith("dist-desktop/") || normalized.startsWith("assets/") || normalized === "package.json")) continue;
    try {
      const content = extractFile(asar, entry.replace(/^\\/, "")).toString("utf8");
      for (const pattern of forbidden) if (pattern.test(content)) findings.push(`app.asar/${normalized}`);
      if (publicFirebaseKey.test(content)) warnings.push({ path: `app.asar/${normalized}`, type: "firebase-web-api-key" });
    } catch {
      // Directory entries are returned by listPackage as well; only files are scannable.
    }
  }
}

const uniqueFindings = [...new Set(findings)];
const uniqueWarnings = warnings.filter((warning, index, all) => all.findIndex((item) => item.path === warning.path && item.type === warning.type) === index);
console.log(JSON.stringify({ root, findings: uniqueFindings, warnings: uniqueWarnings, checked: true }, null, 2));
if (uniqueFindings.length) process.exitCode = 1;
