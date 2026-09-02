import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(process.argv[2] || process.env.LOHZ_ARTIFACT_ROOT || "release");
const artifactPattern = /\.(exe|deb|dmg|AppImage|zip|7z|tar\.gz)$/i;
const artifacts = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile() && artifactPattern.test(entry.name)) {
      const data = fs.readFileSync(absolute);
      artifacts.push({
        file: path.relative(root, absolute).replaceAll(path.sep, "/"),
        sha256: crypto.createHash("sha256").update(data).digest("hex"),
        bytes: data.length,
      });
    }
  }
}

walk(root);
artifacts.sort((a, b) => a.file.localeCompare(b.file));
const output = path.join(root, "SHA256SUMS.txt");
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(output, artifacts.map((item) => `${item.sha256}  ${item.file}`).join("\n") + (artifacts.length ? "\n" : ""), "utf8");
console.log(JSON.stringify({ output, artifacts }, null, 2));
