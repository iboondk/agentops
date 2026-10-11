import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import type { LLMResponse, Message, RunResult, ToolCall } from '../core/types.js';
import { AgentError, TimeoutError } from '../core/errors.js';
import { Budget, type BudgetLimits } from '../core/budget.js';
import { withRetry } from '../core/retry.js';
import { withTimeout } from '../core/timeout.js';
import { costOf } from '../config/pricing.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ToolRegistry } from '../tools/registry.js';

/**
 * Optional observation hooks. `onLlm` fires after each successful LLM call, `onTool` after each
 * tool execution. Hooks run whether or not a tracer is configured.
 */
export interface RuntimeHooks {
  onLlm?(r: LLMResponse, ms: number): void;
  onTool?(name: string, ok: boolean, ms: number): void;
}

export interface AgentOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  budget?: BudgetLimits;
  maxSteps?: number;
  llmTimeoutMs?: number;
  llmRetries?: number;
  systemPrompt?: string;
  hooks?: RuntimeHooks;
  /**
   * Optional OpenTelemetry tracer. When set, each run produces an `agent.run` root span with
   * `llm.call` and `tool.<name>` child spans. Without it, behaviour is unchanged.
   */
  tracer?: Tracer;
}

export interface AgentTask {
  id: string;
  input: string;
}

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_LLM_TIMEOUT_MS = 30_000;
const DEFAULT_LLM_RETRIES = 2;
const LLM_RETRY_BASE_DELAY_MS = 100;
const PREVIEW_CHARS = 200;

function preview(text: string): string {
  return text.slice(0, PREVIEW_CHARS);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AgentRuntime {
  private readonly o: AgentOptions;

  constructor(o: AgentOptions) {
    this.o = o;
  }

  /** Core loop: LLM call -> budget check -> tool calls (fed back as tool messages) -> final answer. */
  async run(task: AgentTask): Promise<RunResult> {
    const tracer = this.o.tracer;
    if (!tracer) return this.execute(task, undefined);

    const root = tracer.startSpan('agent.run', {
      attributes: {
        'agent.task_id': task.id,
        'agent.model': this.o.provider.model,
        'agent.input': preview(task.input),
      },
    });
    // Children get this context passed explicitly to startSpan, so no context manager is needed.
    const parent = trace.setSpan(context.active(), root);

    let result: RunResult | undefined;
    try {
      const executed = await this.execute(task, parent);
      result = { ...executed, traceId: root.spanContext().traceId };
      return result;
    } catch (err) {
      root.recordException(err instanceof Error ? err : new Error(String(err)));
      root.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
      throw err;
    } finally {
      if (result) {
        root.setAttributes({
          'agent.status': result.status,
          'agent.cost_usd': result.costUsd,
          'agent.input_tokens': result.usage.inputTokens,
          'agent.output_tokens': result.usage.outputTokens,
          'agent.steps': result.steps,
        });
        if (result.status !== 'ok') {
          root.setStatus({ code: SpanStatusCode.ERROR, message: result.error ?? result.status });
        }
      }
      root.end();
    }
  }

  private async execute(task: AgentTask, parent: Context | undefined): Promise<RunResult> {
    const { provider, registry, hooks } = this.o;
    const maxSteps = this.o.maxSteps ?? DEFAULT_MAX_STEPS;
    const llmTimeoutMs = this.o.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    const llmRetries = this.o.llmRetries ?? DEFAULT_LLM_RETRIES;

    const started = Date.now();
    const budget = new Budget(this.o.budget ?? {}, provider.model);
    const toolCalls: RunResult['toolCalls'] = [];
    const messages: Message[] = [];
    if (this.o.systemPrompt) messages.push({ role: 'system', content: this.o.systemPrompt });
    messages.push({ role: 'user', content: task.input });
    const toolSpecs = registry.specs();

    const finish = (status: RunResult['status'], output: string, error?: string): RunResult => ({
      taskId: task.id,
      status,
      output,
      steps: budget.steps,
      usage: budget.usage,
      costUsd: budget.costUsd,
      toolCalls,
      error,
      durationMs: Date.now() - started,
    });

    try {
      for (let step = 0; step < maxSteps; step++) {
        budget.step();

        const llmStart = Date.now();
        let response: LLMResponse;
        try {
          response = await this.withSpan('llm.call', { 'gen_ai.request.model': provider.model }, parent, async (span) => {
            let attempts = 0;
            try {
              const res = await withRetry(
                (attempt) => {
                  attempts = attempt;
                  return withTimeout(
                    (signal) => provider.complete(messages, toolSpecs, { signal }),
                    llmTimeoutMs,
                    'llm call',
                  );
                },
                { retries: llmRetries, baseDelayMs: LLM_RETRY_BASE_DELAY_MS },
              );
              span?.setAttributes({
                'gen_ai.usage.input_tokens': res.usage.inputTokens,
                'gen_ai.usage.output_tokens': res.usage.outputTokens,
                'llm.cost_usd': costOf(res.usage, provider.model),
              });
              return res;
            } finally {
              span?.setAttribute('llm.attempts', attempts);
            }
          });
        } catch (err) {
          if (err instanceof TimeoutError) return finish('timeout', '', err.message);
          throw err;
        }
        const llmMs = Date.now() - llmStart;
        hooks?.onLlm?.(response, llmMs);

        budget.record(response.usage);
        if (budget.exceeded() !== null) {
          return finish('budget_exceeded', response.content, `Budget exceeded: ${budget.exceeded()}`);
        }

        messages.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        if (response.toolCalls.length === 0) {
          return finish('ok', response.content);
        }

        for (const call of response.toolCalls) {
          await this.runToolCall(call, messages, toolCalls, parent);
        }
      }
      return finish('max_steps', '', `Step limit reached (${maxSteps})`);
    } catch (err) {
      return finish('error', '', errorMessage(err));
    }
  }

  /** Executes one tool call. Failures are fed back to the model as `ERROR: <msg>`, never thrown. */
  private async runToolCall(
    call: ToolCall,
    messages: Message[],
    toolCalls: RunResult['toolCalls'],
    parent: Context | undefined,
  ): Promise<void> {
    const start = Date.now();
    let ok = true;
    let content = '';
    await this.withSpan(
      `tool.${call.name}`,
      { 'tool.name': call.name, 'tool.args': preview(JSON.stringify(call.args)) },
      parent,
      async (span) => {
        try {
          content = await this.o.registry.execute(call.name, call.args);
        } catch (err) {
          ok = false;
          const msg = err instanceof AgentError || err instanceof Error ? err.message : String(err);
          content = `ERROR: ${msg}`;
          if (span) {
            span.recordException(err instanceof Error ? err : new Error(msg));
            span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
          }
        }
        span?.setAttributes({ 'tool.ok': ok, 'tool.output': preview(content) });
      },
    );
    const ms = Date.now() - start;
    toolCalls.push({ name: call.name, ok, durationMs: ms });
    this.o.hooks?.onTool?.(call.name, ok, ms);
    messages.push({ role: 'tool', content, toolCallId: call.id, name: call.name });
  }

  /**
   * Runs `fn` inside a child span of `parent`. Without a tracer (parent undefined) it just calls
   * `fn(undefined)`. Records exceptions and sets ERROR status on throw, and always ends the span.
   */
  private async withSpan<T>(
    name: string,
    attributes: Attributes,
    parent: Context | undefined,
    fn: (span: Span | undefined) => Promise<T>,
  ): Promise<T> {
    const tracer = this.o.tracer;
    if (!tracer || !parent) return fn(undefined);

    const span = tracer.startSpan(name, { attributes }, parent);
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
      throw err;
    } finally {
      span.end();
    }
  }
}
