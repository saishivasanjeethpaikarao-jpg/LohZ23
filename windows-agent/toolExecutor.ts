/**
 * Tool executor: runs a ToolDefinition with validation, timeout, and structured results.
 * Every call is logged through utils/logging.ts.
 */
import { logExecution } from "./utils/logging";
import { getTool } from "./toolRegistry";
import type { ToolResult } from "./types";

function errorOf(err: any): { code: string; details?: string } {
  if (err && typeof err.code === "string") return { code: err.code, details: err.message };
  return { code: "TOOL_ERROR", details: (err && err.message) || String(err) };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TOOL_TIMEOUT")), Math.max(1, ms - 50));
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function defaultMessage(): string {
  return "Execution failed.";
}

function buildFailureResult(
  name: string,
  risk: string,
  start: number,
  err: any
): ToolResult {
  const durationMs = Date.now() - start;
  const errInfo = errorOf(err);
  const fallback = defaultMessage();
  const safeMessage = errInfo.details || fallback;
  logExecution({
    tool: name,
    params: {},
    risk,
    success: false,
    durationMs,
    errorCode: errInfo.code,
    message: safeMessage,
  });
  return {
    success: false,
    tool: name,
    message: safeMessage,
    data: {},
    error: errInfo,
  };
}

export async function executeTool(
  name: string,
  params: Record<string, any>
): Promise<ToolResult> {
  const tool = getTool(name);
  const start = Date.now();

  if (!tool) {
    const fallbackMsg = "No tool is registered under that name.";
    const error = { code: "TOOL_NOT_REGISTERED", details: fallbackMsg };
    logExecution({
      tool: name,
      params: {},
      risk: "UNKNOWN",
      success: false,
      durationMs: 0,
      errorCode: error.code,
      message: fallbackMsg,
    });
    return { success: false, tool: name, message: fallbackMsg, data: {}, error };
  }

  const validation = tool.validate(params);
  if (!validation.valid) {
    const fallbackMsg = validation.error || "Invalid parameters.";
    const error = { code: "VALIDATION_FAILED", details: fallbackMsg };
    logExecution({
      tool: name,
      params: {},
      risk: tool.risk,
      success: false,
      durationMs: Date.now() - start,
      errorCode: error.code,
      message: fallbackMsg,
    });
    return {
      success: false,
      tool: name,
      message: fallbackMsg,
      data: {},
      error,
    };
  }

  try {
    const partial = await withTimeout(tool.execute(params), tool.timeoutMs);
    const durationMs = Date.now() - start;
    logExecution({
      tool: name,
      params: {},
      risk: tool.risk,
      success: true,
      durationMs,
      errorCode: null,
      message: partial.message,
    });
    return {
      success: true,
      tool: name,
      message: partial.message,
      data: partial.data || {},
      error: null,
    };
  } catch (err: any) {
    return buildFailureResult(name, tool.risk, start, err);
  }
}
