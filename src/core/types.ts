export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
}

export type RunStatus = 'ok' | 'error' | 'budget_exceeded' | 'max_steps' | 'timeout';

export interface RunResult {
  taskId: string;
  status: RunStatus;
  output: string;
  steps: number;
  usage: Usage;
  costUsd: number;
  toolCalls: { name: string; ok: boolean; durationMs: number }[];
  traceId?: string;
  error?: string;
  durationMs: number;
}
