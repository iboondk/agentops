import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentError, RetryableError } from '../core/errors.js';
import { withRetry } from '../core/retry.js';
import { withTimeout } from '../core/timeout.js';

export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
const RETRY_BASE_DELAY_MS = 100;

export interface ToolContext {
  signal: AbortSignal;
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  timeoutMs?: number;
  /** Retries after the first attempt, only for errors that are RetryableError. Default 0. */
  retries?: number;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

export function defineTool<S extends z.ZodTypeAny>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef<any>>();

  register(t: ToolDef<any>): this {
    if (this.tools.has(t.name)) {
      throw new AgentError(`Tool already registered: ${t.name}`);
    }
    this.tools.set(t.name, t);
    return this;
  }

  get(name: string): ToolDef<any> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef<any>[] {
    return [...this.tools.values()];
  }

  specs(): ToolSpec[] {
    return this.list().map((t) => {
      const schema = zodToJsonSchema(t.schema, { $refStrategy: 'none' }) as Record<string, unknown>;
      // Strip the draft meta key; providers and MCP clients only need the schema body.
      const { $schema: _unused, ...inputSchema } = schema;
      void _unused;
      return { name: t.name, description: t.description, inputSchema };
    });
  }

  /**
   * Validates args with the tool's zod schema, then runs it with a per-attempt timeout.
   * Retries only RetryableError, up to `tool.retries` times.
   */
  async execute(name: string, args: unknown, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AgentError(`Unknown tool: ${name}`);
    }

    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i: z.ZodIssue) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new AgentError(`Invalid arguments for tool ${name}: ${detail}`);
    }
    const input = parsed.data;
    const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

    return withRetry(
      () =>
        withTimeout(
          (signal) =>
            tool.run(input, {
              signal: opts.signal ? AbortSignal.any([signal, opts.signal]) : signal,
            }),
          timeoutMs,
          `tool ${name}`,
        ),
      {
        retries: tool.retries ?? 0,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        shouldRetry: (err) => err instanceof RetryableError,
      },
    );
  }
}
