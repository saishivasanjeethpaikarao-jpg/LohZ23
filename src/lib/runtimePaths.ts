import path from "node:path";

/** Mutable runtime state belongs outside a packaged, read-only app bundle. */
export function runtimeAppRoot(): string {
  return path.resolve(process.env.LOHZ_APP_ROOT || process.cwd());
}

export function runtimeDataRoot(...parts: string[]): string {
  const root = path.resolve(process.env.LOHZ_DATA_DIR || path.join(process.cwd(), "data"));
  return path.join(root, ...parts);
}

export function runtimePrivateFile(name: string): string {
  return path.join(path.resolve(process.env.LOHZ_DATA_DIR || process.cwd()), name);
}
