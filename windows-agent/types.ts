/**
 * Shared types for the LOHZ Windows Agent.
 * Used by the agent itself and by the main server's tool router / bridge.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export type ToolCategory =
  | "applications"
  | "browser"
  | "files"
  | "windows"
  | "clipboard"
  | "screen"
  | "system";

export interface ToolError {
  code: string;
  details?: string;
}

export interface ToolResult {
  success: boolean;
  tool: string;
  message: string;
  data: Record<string, any>;
  error: ToolError | null;
}

/** Plain JSON-schema-style parameter descriptor (values mirror @google/genai Type enum strings). */
export interface ParamSchema {
  type: "OBJECT" | "STRING" | "INTEGER" | "BOOLEAN" | "ARRAY" | "NUMBER";
  description?: string;
  enum?: string[];
  items?: ParamSchema;
  properties?: Record<string, ParamSchema>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  risk: RiskLevel;
  /** Hard execution timeout in ms. */
  timeoutMs: number;
  /** Gemini-facing parameter schema (also validated before execution). */
  parameters: ParamSchema;
  /** Runtime validation of parameter values (paths, ranges, content size). */
  validate: (params: Record<string, any>) => { valid: boolean; error?: string };
  /** Executes the tool. Return partial result; executor fills the rest. */
  execute: (params: Record<string, any>) => Promise<{
    message: string;
    data?: Record<string, any>;
  }>;
}

export interface ExecuteRequest {
  requestId?: string;
  tool: string;
  params: Record<string, any>;
}

export interface AgentStatus {
  online: boolean;
  connectedClients: number;
  lastActivityAt: number;
  toolsRegistered: number;
  host: string;
  port: number;
  lastError?: string | null;
}
