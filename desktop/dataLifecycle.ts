import fs from "node:fs";
import path from "node:path";

export const DATA_SCHEMA_VERSION = 1;

function safeJoin(root: string, ...children: string[]): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...children);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("Path escapes data root");
  return target;
}

export function ensureDataLayout(root: string): void {
  for (const dir of [root, "backups", "runtime", "migrations"].map((part) => part === root ? root : safeJoin(root, part))) fs.mkdirSync(dir, { recursive: true });
}

export function migrateLegacyLayout(appRoot: string, dataRoot: string): { migrated: string[]; schemaVersion: number } {
  ensureDataLayout(dataRoot);
  const migrated: string[] = [];
  const sources = ["data", ".credentials.enc", ".credential_store_key", ".agent-token"];
  for (const name of sources) {
    const source = safeJoin(appRoot, name);
    const destination = safeJoin(dataRoot, name);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    fs.cpSync(source, destination, { recursive: true, errorOnExist: false });
    migrated.push(name);
  }
  fs.writeFileSync(safeJoin(dataRoot, "migrations", "manifest.json"), JSON.stringify({ schemaVersion: DATA_SCHEMA_VERSION, migrated, migratedAt: new Date().toISOString() }, null, 2));
  return { migrated, schemaVersion: DATA_SCHEMA_VERSION };
}

export function createBackup(dataRoot: string): string {
  ensureDataLayout(dataRoot);
  const name = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const destination = safeJoin(dataRoot, path.join("backups", name));
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
    if (entry.name === "backups" || entry.name === "runtime") continue;
    fs.cpSync(path.join(dataRoot, entry.name), path.join(destination, entry.name), { recursive: true });
  }
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({ schemaVersion: DATA_SCHEMA_VERSION, createdAt: new Date().toISOString() }, null, 2));
  return destination;
}

export function markSession(dataRoot: string, clean: boolean): void {
  ensureDataLayout(dataRoot);
  fs.writeFileSync(safeJoin(dataRoot, "runtime", "session-state.json"), JSON.stringify({ clean, updatedAt: new Date().toISOString() }, null, 2));
}

export function hadUncleanShutdown(dataRoot: string): boolean {
  const file = safeJoin(dataRoot, "runtime/session-state.json");
  if (!fs.existsSync(file)) return false;
  try { return JSON.parse(fs.readFileSync(file, "utf8")).clean !== true; } catch { return true; }
}

export function restoreBackup(dataRoot: string, backupPath: string): void {
  const backup = path.resolve(backupPath);
  if (!fs.existsSync(path.join(backup, "manifest.json"))) throw new Error("Backup manifest is missing");
  ensureDataLayout(dataRoot);
  for (const entry of fs.readdirSync(backup, { withFileTypes: true })) {
    if (entry.name === "manifest.json") continue;
    fs.cpSync(path.join(backup, entry.name), safeJoin(dataRoot, entry.name), { recursive: true, force: true });
  }
}
