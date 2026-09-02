import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const inputRoot = path.resolve(process.argv[2] || "release-artifacts");
const outputRoot = path.resolve(process.argv[3] || "publish");
const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
const artifactPattern = /\.(exe|deb|dmg|AppImage|zip|7z|tar\.gz)$/i;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function platformFor(file) {
  if (/\.exe$/i.test(file)) return "windows";
  if (/\.(deb|AppImage)$/i.test(file)) return "linux";
  return "macos";
}

function architectureFor(file) {
  if (/x64|amd64/i.test(file)) return "x64";
  if (/arm64|aarch64/i.test(file)) return "arm64";
  return "unspecified";
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

const packageFiles = walk(inputRoot).filter((file) => artifactPattern.test(file));
if (packageFiles.length === 0) {
  throw new Error(`No desktop packages found under ${inputRoot}`);
}

const usedNames = new Set();
const artifacts = packageFiles.map((source) => {
  const platform = platformFor(source);
  const originalName = path.basename(source);
  let name = originalName;
  if (usedNames.has(name)) name = `${platform}-${name}`;
  while (usedNames.has(name)) name = `${platform}-${name}`;
  usedNames.add(name);
  const destination = path.join(outputRoot, name);
  fs.copyFileSync(source, destination);
  const data = fs.readFileSync(destination);
  return {
    path: name,
    bytes: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    platform,
    architecture: architectureFor(originalName),
    signing: process.env.LOHZ_SIGNED_RELEASE === "true" ? "configured" : "unsigned",
    qa: process.env.LOHZ_NATIVE_QA === "true" ? "native" : "artifact-only",
  };
});

const commitSha = process.env.GITHUB_SHA || "unknown";
const manifest = {
  schemaVersion: 3,
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
  artifacts,
};

fs.writeFileSync(path.join(outputRoot, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
fs.writeFileSync(
  path.join(outputRoot, "SHA256SUMS.txt"),
  artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n") + "\n",
  "utf8",
);
console.log(JSON.stringify({ outputRoot, version: manifest.version, artifactCount: artifacts.length }, null, 2));
