import type { LLMResponse, Message, ToolCall } from '../core/types.js';
import { AgentError, RetryableError } from '../core/errors.js';
import type { ToolSpec } from '../tools/registry.js';
import type { LLMProvider } from './provider.js';

export interface MockProviderOptions {
  model?: string;
  /** The first N calls throw RetryableError('mock transient'). */
  failFirstN?: number;
  /** Artificial latency per call, abortable. */
  latencyMs?: number;
}

function sumChars(messages: Message[]): number {
  return messages.reduce((n, m) => n + m.content.length, 0);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new AgentError('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new AgentError('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Deterministic rule-based provider for offline runs and tests. No network, no cost.
 * Rules look at the LAST user message and whether a tool result already exists.
 */
export class MockProvider implements LLMProvider {
  readonly model: string;
  private readonly failFirstN: number;
  private readonly latencyMs: number;
  private callCount = 0;
  private idCounter = 0;

  constructor(opts: MockProviderOptions = {}) {
    this.model = opts.model ?? 'mock-small';
    this.failFirstN = opts.failFirstN ?? 0;
    this.latencyMs = opts.latencyMs ?? 0;
  }

  async complete(
    messages: Message[],
    tools: ToolSpec[],
    opts: { signal: AbortSignal },
  ): Promise<LLMResponse> {
    this.callCount += 1;
    if (this.latencyMs > 0) await sleep(this.latencyMs, opts.signal);
    if (this.callCount <= this.failFirstN) {
      throw new RetryableError('mock transient');
    }

    const toolNames = new Set(tools.map((t) => t.name));
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userText = lastUser?.content ?? '';
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');

    let content = '';
    let toolCalls: ToolCall[] = [];

    if (lastTool) {
      content = `Answer: ${lastTool.content.slice(0, 500)}`;
    } else {
      const call = this.pickToolCall(userText, toolNames);
      if (call) {
        toolCalls = [call];
      } else {
        content = `Summary: ${userText.slice(0, 200)}`;
      }
    }

    const outputChars = content.length;
    return {
      content,
      toolCalls,
      model: this.model,
      usage: {
        inputTokens: Math.ceil(sumChars(messages) / 4),
        // Each tool call adds a flat 10 output tokens on top of the text tokens.
        outputTokens: Math.ceil(outputChars / 4) + 10 * toolCalls.length,
      },
    };
  }

  private nextId(): string {
    this.idCounter += 1;
    return `call_${this.idCounter}`;
  }

  private pickToolCall(userText: string, toolNames: Set<string>): ToolCall | null {
    let m = /calculate (.+)/i.exec(userText);
    if (m && toolNames.has('calculator')) {
      return { id: this.nextId(), name: 'calculator', args: { expression: m[1]!.trim() } };
    }

    m = /https?:\/\/\S+/.exec(userText);
    if (m && toolNames.has('http_fetch')) {
      return { id: this.nextId(), name: 'http_fetch', args: { url: m[0] } };
    }

    m = /search (?:for )?['"]?([^'"]+)['"]?/i.exec(userText);
    if (m && toolNames.has('fs_search')) {
      return { id: this.nextId(), name: 'fs_search', args: { query: m[1]!.trim() } };
    }

    return null;
  }
}
