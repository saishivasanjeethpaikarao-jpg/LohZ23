import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(process.argv[2] || process.env.LOHZ_ARTIFACT_ROOT || "release");
const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
const ignored = new Set(["release-manifest.json", "SHA256SUMS.txt"]);
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile()) {
      const data = fs.readFileSync(absolute);
      files.push({
        path: path.relative(root, absolute).replaceAll(path.sep, "/"),
        bytes: data.length,
        sha256: crypto.createHash("sha256").update(data).digest("hex"),
      });
    }
  }
}

walk(root);
const artifactPattern = /\.(exe|deb|dmg|AppImage|zip|7z|tar\.gz)$/i;
let commitSha = process.env.GITHUB_SHA || "unknown";
if (commitSha === "unknown") {
  try {
    const head = fs.readFileSync(path.join(".git", "HEAD"), "utf8").trim();
    const ref = head.startsWith("ref:") ? head.slice(5).trim() : null;
    commitSha = ref ? fs.readFileSync(path.join(".git", ref), "utf8").trim() : head;
  } catch {
    // Source archives may not contain Git metadata.
  }
}
const manifest = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  application: packageJson.name,
  version: packageJson.version,
  appId: "com.lohz.desktop",
  commitSha,
  buildEnvironment: {
    ci: process.env.CI === "true",
    runner: process.env.RUNNER_OS || process.platform,
    node: process.version,
  },
  root,
  artifactsPresent: files.some((file) => artifactPattern.test(file.path)),
  files,
  artifacts: files
    .filter((file) => artifactPattern.test(file.path))
    .map((file) => ({
      ...file,
      platform: /\.exe$/i.test(file.path) ? "windows" : /\.(deb|AppImage)$/i.test(file.path) ? "linux" : "macos",
      architecture: /x64|amd64/i.test(file.path) ? "x64" : "unspecified",
      signing: process.env.LOHZ_SIGNED_RELEASE === "true" ? "configured" : "unsigned",
      qa: process.env.LOHZ_NATIVE_QA === "true" ? "native" : "artifact-only",
    })),
};
const output = path.join(root, "release-manifest.json");
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ output, artifactsPresent: manifest.artifactsPresent, fileCount: files.length, version: manifest.version }, null, 2));
