/**
 * Isolated legacy Gemini-Live adapter pending the separate duplicate-system
 * cleanup decision. Direct bridge execution is disabled: all tool intents
 * must enter the authenticated cognitive pipeline.
 */
import { getTool, toAllGeminiDeclarations } from "./windows-agent/toolRegistry";

export interface GeminiToolResult {
  success: boolean;
  tool: string;
  message: string;
  data: Record<string, unknown>;
  error: { code: string; details?: string } | null;
  requiresConfirmation?: boolean;
}

export async function routeGeminiToolCall(
  toolName: string,
  params: Record<string, unknown>
): Promise<GeminiToolResult> {
  const tool = getTool(toolName);
  if (!tool) {
    return { success: false, tool: toolName, message: "Tool is not registered.", data: {}, error: { code: "TOOL_NOT_REGISTERED" } };
  }
  const validation = tool.validate(params);
  if (!validation.valid) {
    return { success: false, tool: toolName, message: "Tool arguments were rejected.", data: {}, error: { code: "VALIDATION_FAILED" } };
  }
  return {
    success: false,
    tool: toolName,
    message: "Direct Live tool execution is disabled; submit the intent through /api/route.",
    data: {},
    error: { code: "COGNITIVE_ENTRY_REQUIRED" },
    requiresConfirmation: tool.risk !== "LOW",
  };
}

export function getAllGeminiDeclarations() {
  return toAllGeminiDeclarations();
}
