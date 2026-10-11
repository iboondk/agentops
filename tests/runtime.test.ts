import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { costOf } from '../src/config/pricing.js';
import { MockProvider } from '../src/llm/mockProvider.js';
import { createDefaultRegistry } from '../src/tools/index.js';
import { fileURLToPath } from 'node:url';

const sandboxDir = fileURLToPath(new URL('../sandbox', import.meta.url));

function makeRuntime(provider: MockProvider, extra: { maxSteps?: number; budget?: { maxUsd?: number } } = {}) {
  return new AgentRuntime({
    provider,
    registry: createDefaultRegistry({ sandboxDir }),
    ...extra,
  });
}

describe('AgentRuntime', () => {
  it("'calculate 6*7' completes with status ok, output 42 and one tool call", async () => {
    const runtime = makeRuntime(new MockProvider());
    const result = await runtime.run({ id: 't1', input: 'calculate 6*7' });
    expect(result.status).toBe('ok');
    expect(result.output).toContain('42');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: 'calculator', ok: true });
    expect(result.taskId).toBe('t1');
  });

  it('still succeeds when the provider fails its first call (retry path)', async () => {
    const runtime = makeRuntime(new MockProvider({ failFirstN: 1 }));
    const result = await runtime.run({ id: 't2', input: 'calculate 6*7' });
    expect(result.status).toBe('ok');
    expect(result.output).toContain('42');
  });

  it('returns budget_exceeded when maxUsd is tiny', async () => {
    const runtime = makeRuntime(new MockProvider(), { budget: { maxUsd: 1e-9 } });
    const result = await runtime.run({ id: 't3', input: 'calculate 6*7' });
    expect(result.status).toBe('budget_exceeded');
  });

  it('returns max_steps when maxSteps is 1 and the task needs a tool', async () => {
    const runtime = makeRuntime(new MockProvider(), { maxSteps: 1 });
    const result = await runtime.run({ id: 't4', input: 'calculate 6*7' });
    expect(result.status).toBe('max_steps');
    expect(result.steps).toBe(1);
  });

  it('reports costUsd equal to costOf(usage, mock-small)', async () => {
    const runtime = makeRuntime(new MockProvider());
    const result = await runtime.run({ id: 't5', input: 'calculate 6*7' });
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(costOf(result.usage, 'mock-small'), 12);
  });

  it('feeds tool errors back to the model as ERROR messages and still finishes', async () => {
    const runtime = makeRuntime(new MockProvider());
    const result = await runtime.run({ id: 't6', input: 'calculate 1/0' });
    expect(result.status).toBe('ok');
    expect(result.toolCalls[0]).toMatchObject({ name: 'calculator', ok: false });
    expect(result.output).toContain('ERROR: Division by zero');
  });

  it('returns status error when the provider keeps failing past the retry limit', async () => {
    const runtime = makeRuntime(new MockProvider({ failFirstN: 10 }));
    const result = await runtime.run({ id: 't7', input: 'hello' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('mock transient');
  });

  it('invokes hooks for each LLM call and tool execution', async () => {
    const llm: string[] = [];
    const tools: string[] = [];
    const runtime = new AgentRuntime({
      provider: new MockProvider(),
      registry: createDefaultRegistry({ sandboxDir }),
      hooks: {
        onLlm: (r) => llm.push(r.model),
        onTool: (name, ok) => tools.push(`${name}:${ok}`),
      },
    });
    await runtime.run({ id: 't8', input: 'calculate 2+2' });
    expect(llm).toHaveLength(2);
    expect(tools).toEqual(['calculator:true']);
  });
});
