/**
 * File tools: createFile / readFile / writeFile / createFolder / renameFile.
 * All paths pass through resolveSafePath (Desktop / Documents / Downloads / workspace only).
 */
import fsp from "fs/promises";
import path from "path";
import { LIMITS, isSafeBasename, resolveSafePath } from "../utils/validation";

function pathFailure(inputPath: string): Error {
  const res = resolveSafePath(inputPath);
  const e = new Error(`${res.errorCode}: ${res.details} (path: "${inputPath}")`);
  (e as any).code = res.errorCode || "PATH_INVALID";
  return e;
}

function resolveOrFail(inputPath: string): string {
  const res = resolveSafePath(inputPath);
  if (!res.ok || !res.target) throw pathFailure(inputPath);
  return res.target;
}

export async function createFile(params: Record<string, any>) {
  const target = resolveOrFail(String(params.path || ""));
  const content = typeof params.content === "string" ? params.content : "";
  if (Buffer.byteLength(content, "utf-8") > LIMITS.WRITE_MAX_BYTES) {
    const e = new Error(`Content exceeds ${LIMITS.WRITE_MAX_BYTES} byte limit.`);
    (e as any).code = "CONTENT_TOO_LARGE";
    throw e;
  }
  try {
    await fsp.writeFile(target, content, { encoding: "utf-8", flag: "wx" });
  } catch (err: any) {
    if (err.code === "EEXIST") {
      const e = new Error(`File already exists: ${target}`);
      (e as any).code = "FILE_EXISTS";
      throw e;
    }
    const e = new Error(`Could not create file: ${err.message}`);
    (e as any).code = "FILE_CREATE_FAILED";
    throw e;
  }
  return { message: `Created file ${target}.`, data: { path: target, bytes: Buffer.byteLength(content, "utf-8") } };
}

export async function readFile(params: Record<string, any>) {
  const target = resolveOrFail(String(params.path || ""));
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    const e = new Error(`File not found: ${target}`);
    (e as any).code = "FILE_NOT_FOUND";
    throw e;
  }
  if (!stat.isFile()) {
    const e = new Error(`Not a file: ${target}`);
    (e as any).code = "NOT_A_FILE";
    throw e;
  }
  if (stat.size > LIMITS.READ_MAX_BYTES) {
    const e = new Error(`File is ${stat.size} bytes; limit is ${LIMITS.READ_MAX_BYTES}.`);
    (e as any).code = "FILE_TOO_LARGE";
    throw e;
  }
  let content: string;
  try {
    const buf = await fsp.readFile(target);
    // Refuse to read binary-looking data as text.
    for (let i = 0; i < Math.min(buf.length, 4096); i++) {
      if (buf[i] === 0) {
        const e = new Error("File appears to be binary; text read refused.");
        (e as any).code = "FILE_BINARY";
        throw e;
      }
    }
    content = buf.toString("utf-8");
  } catch (err: any) {
    if ((err as any).code) throw err;
    const e = new Error(`Read failed: ${err.message}`);
    (e as any).code = "FILE_READ_FAILED";
    throw e;
  }
  return {
    message: `Read ${content.length} characters from ${target}.`,
    data: { path: target, content, sizeBytes: stat.size },
  };
}

export async function writeFile(params: Record<string, any>) {
  const target = resolveOrFail(String(params.path || ""));
  if (typeof params.content !== "string") {
    const e = new Error("Parameter 'content' (string) is required.");
    (e as any).code = "PARAM_MISSING";
    throw e;
  }
  if (Buffer.byteLength(params.content, "utf-8") > LIMITS.WRITE_MAX_BYTES) {
    const e = new Error(`Content exceeds ${LIMITS.WRITE_MAX_BYTES} byte limit.`);
    (e as any).code = "CONTENT_TOO_LARGE";
    throw e;
  }
  try {
    const existed = (await fsp.stat(target).catch(() => null)) !== null;
    await fsp.writeFile(target, params.content, "utf-8");
    return {
      message: `${existed ? "Overwrote" : "Wrote"} ${target} (${Buffer.byteLength(params.content, "utf-8")} bytes).`,
      data: { path: target, bytes: Buffer.byteLength(params.content, "utf-8"), existed },
    };
  } catch (err: any) {
    const e = new Error(`Write failed: ${err.message}`);
    (e as any).code = "FILE_WRITE_FAILED";
    throw e;
  }
}

export async function createFolder(params: Record<string, any>) {
  const target = resolveOrFail(String(params.path || ""));
  try {
    await fsp.mkdir(target, { recursive: true });
  } catch (err: any) {
    const e = new Error(`Could not create folder: ${err.message}`);
    (e as any).code = "FOLDER_CREATE_FAILED";
    throw e;
  }
  return { message: `Folder ready at ${target}.`, data: { path: target } };
}

export async function renameFile(params: Record<string, any>) {
  const target = resolveOrFail(String(params.path || ""));
  const newName = String(params.newName || "");
  if (!isSafeBasename(newName)) {
    const e = new Error(`Invalid new name "${newName}" (must be a plain name without separators).`);
    (e as any).code = "INVALID_NAME";
    throw e;
  }
  try {
    await fsp.access(target);
  } catch {
    const e = new Error(`Source not found: ${target}`);
    (e as any).code = "FILE_NOT_FOUND";
    throw e;
  }
  const destination = path.join(path.dirname(target), newName);
  // Re-validate destination stays in the same safe directory family.
  const destCheck = resolveSafePath(destination);
  if (!destCheck.ok || !destCheck.target) throw pathFailure(destination);
  try {
    await fsp.rename(target, destCheck.target);
  } catch (err: any) {
    const e = new Error(`Rename failed: ${err.message}`);
    (e as any).code = "RENAME_FAILED";
    throw e;
  }
  return {
    message: `Renamed to ${destCheck.target}.`,
    data: { from: target, to: destCheck.target },
  };
}
