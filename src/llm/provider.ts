import type { LLMResponse, Message } from '../core/types.js';
import type { ToolSpec } from '../tools/registry.js';

export interface LLMProvider {
  readonly model: string;
  complete(
    messages: Message[],
    tools: ToolSpec[],
    opts: { signal: AbortSignal },
  ): Promise<LLMResponse>;
}
