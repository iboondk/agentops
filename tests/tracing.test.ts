import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { MockProvider } from '../src/llm/mockProvider.js';
import { JsonlSpanExporter, MemorySpanExporter, type SpanRecord } from '../src/tracing/jsonlExporter.js';
import { initTracing } from '../src/tracing/tracer.js';
import { createUiServer } from '../src/ui/server.js';
import { createDefaultRegistry } from '../src/tools/index.js';

const sandboxDir = fileURLToPath(new URL('../sandbox', import.meta.url));
const traceDir = fileURLToPath(new URL('../data/tmp-traces', import.meta.url));

function rmTraceDir(): void {
  rmSync(traceDir, { recursive: true, force: true });
}

describe('tracing', () => {
  beforeAll(() => {
    rmTraceDir();
  });

  afterAll(() => {
    rmTraceDir();
  });

  it('records agent.run, llm.call and tool.calculator spans with correct parenting and cost', async () => {
    const memory = new MemorySpanExporter();
    const handle = initTracing({ dir: traceDir, exporters: [memory], serviceName: 'test' });
    try {
      const runtime = new AgentRuntime({
        provider: new MockProvider(),
        registry: createDefaultRegistry({ sandboxDir }),
        tracer: handle.tracer,
      });
      const result = await runtime.run({ id: 'trace-1', input: 'calculate 6*7' });

      expect(result.status).toBe('ok');
      expect(result.output).toContain('42');
      expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);

      const spans = memory.records;
      const root = spans.find((s) => s.name === 'agent.run');
      const llmCalls = spans.filter((s) => s.name === 'llm.call');
      const tool = spans.find((s) => s.name === 'tool.calculator');

      expect(root).toBeDefined();
      expect(llmCalls.length).toBeGreaterThanOrEqual(2);
      expect(tool).toBeDefined();

      // Everything belongs to one trace, and the root has no parent.
      expect(root!.traceId).toBe(result.traceId);
      expect(root!.parentSpanId).toBeNull();
      for (const s of spans) expect(s.traceId).toBe(result.traceId);

      // Tool and LLM spans are children of agent.run.
      expect(tool!.parentSpanId).toBe(root!.spanId);
      for (const call of llmCalls) expect(call.parentSpanId).toBe(root!.spanId);

      expect(root!.attributes['agent.task_id']).toBe('trace-1');
      expect(root!.attributes['agent.status']).toBe('ok');
      expect(root!.attributes['agent.model']).toBe('mock-small');
      expect(root!.attributes['agent.input']).toBe('calculate 6*7');
      expect(root!.status).toBe('ok');

      const cost = root!.attributes['agent.cost_usd'] as number;
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeCloseTo(result.costUsd, 12);

      expect(tool!.attributes['tool.name']).toBe('calculator');
      expect(tool!.attributes['tool.ok']).toBe(true);
      expect(String(tool!.attributes['tool.output'])).toContain('42');
      expect(llmCalls[0]!.attributes['llm.attempts']).toBe(1);
      expect(llmCalls[0]!.attributes['gen_ai.request.model']).toBe('mock-small');
    } finally {
      await handle.shutdown();
    }
  });

  it('records ERROR status on the tool span when a tool fails, and keeps the run going', async () => {
    const memory = new MemorySpanExporter();
    const handle = initTracing({ dir: traceDir, exporters: [memory] });
    try {
      const runtime = new AgentRuntime({
        provider: new MockProvider(),
        registry: createDefaultRegistry({ sandboxDir }),
        tracer: handle.tracer,
      });
      const result = await runtime.run({ id: 'trace-err', input: 'calculate 1/0' });
      expect(result.status).toBe('ok');

      const tool = memory.records.find((s) => s.name === 'tool.calculator');
      expect(tool!.status).toBe('error');
      expect(tool!.attributes['tool.ok']).toBe(false);
      expect(tool!.events.some((e) => e.name === 'exception')).toBe(true);
    } finally {
      await handle.shutdown();
    }
  });

  it('JsonlSpanExporter writes one JSON line per span into data/tmp-traces, grouped by trace', async () => {
    const memory = new MemorySpanExporter();
    const handle = initTracing({ dir: traceDir, exporters: [memory] });
    let traceId: string | undefined;
    try {
      const runtime = new AgentRuntime({
        provider: new MockProvider(),
        registry: createDefaultRegistry({ sandboxDir }),
        tracer: handle.tracer,
      });
      traceId = (await runtime.run({ id: 'trace-jsonl', input: 'calculate 6*7' })).traceId;
      await handle.flush();
    } finally {
      await handle.shutdown();
    }

    expect(traceId).toBeDefined();
    const file = path.join(traceDir, `${traceId}.jsonl`);
    expect(existsSync(file)).toBe(true);

    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(memory.records.length);
    const parsed = lines.map((l) => JSON.parse(l) as SpanRecord);
    for (const r of parsed) {
      expect(r.traceId).toBe(traceId);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(['ok', 'error']).toContain(r.status);
    }
    expect(readdirSync(traceDir).some((f) => f === `${traceId}.jsonl`)).toBe(true);
  });

  it('JsonlSpanExporter creates its directory when it is missing', async () => {
    const dir = path.join(traceDir, 'nested', 'dir');
    const handle = initTracing({ dir });
    try {
      const runtime = new AgentRuntime({
        provider: new MockProvider(),
        registry: createDefaultRegistry({ sandboxDir }),
        tracer: handle.tracer,
      });
      await runtime.run({ id: 'trace-mkdir', input: 'hello' });
    } finally {
      await handle.shutdown();
    }
    expect(readdirSync(dir).some((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('createUiServer serves /ui, /api/traces, /api/traces/:id and rejects bad ids', async () => {
    // Write a trace through the real exporter so the UI reads the same format it produces.
    mkdirSync(traceDir, { recursive: true });
    const memory = new MemorySpanExporter();
    const handle = initTracing({ dir: traceDir, exporters: [memory] });
    let traceId = '';
    try {
      const runtime = new AgentRuntime({
        provider: new MockProvider(),
        registry: createDefaultRegistry({ sandboxDir }),
        tracer: handle.tracer,
      });
      traceId = (await runtime.run({ id: 'trace-ui', input: 'calculate 6*7' })).traceId!;
    } finally {
      await handle.shutdown();
    }

    const server: http.Server = createUiServer(traceDir);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = server.address() as { port: number };
      const base = `http://127.0.0.1:${port}`;

      const page = await fetch(`${base}/ui`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('AgentOps traces');

      const listRes = await fetch(`${base}/api/traces`);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as {
        traceId: string;
        rootName: string;
        status: string;
        startMs: number;
        durationMs: number;
        costUsd: number;
        spanCount: number;
      }[];
      const summary = list.find((t) => t.traceId === traceId);
      expect(summary).toBeDefined();
      expect(summary!.rootName).toBe('agent.run');
      expect(summary!.status).toBe('ok');
      expect(summary!.costUsd).toBeGreaterThan(0);
      expect(summary!.spanCount).toBe(memory.records.filter((r) => r.traceId === traceId).length);
      expect(summary!.durationMs).toBeGreaterThanOrEqual(0);
      // Newest first.
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1]!.startMs).toBeGreaterThanOrEqual(list[i]!.startMs);
      }

      const detailRes = await fetch(`${base}/api/traces/${traceId}`);
      expect(detailRes.status).toBe(200);
      const spans = (await detailRes.json()) as SpanRecord[];
      expect(spans.map((s) => s.name)).toContain('tool.calculator');

      const badRes = await fetch(`${base}/api/traces/not-a-valid-id`);
      expect(badRes.status).toBe(400);

      const missingRes = await fetch(`${base}/api/traces/${'0'.repeat(32)}`);
      expect(missingRes.status).toBe(404);

      const unknownRes = await fetch(`${base}/nope`);
      expect(unknownRes.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('keeps the run and the JSONL file when the optional OTLP endpoint is unreachable', async () => {
    const saved = {
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      pk: process.env.LANGFUSE_PUBLIC_KEY,
      sk: process.env.LANGFUSE_SECRET_KEY,
    };
    // Port 9 (discard) on loopback is closed here, so every OTLP export fails with ECONNREFUSED.
    // The Langfuse keys are dummy values; nothing leaves the machine.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-dummy';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test-dummy';
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });

    let traceId: string | undefined;
    try {
      const handle = initTracing({ dir: traceDir });
      try {
        const runtime = new AgentRuntime({
          provider: new MockProvider(),
          registry: createDefaultRegistry({ sandboxDir }),
          tracer: handle.tracer,
        });
        const result = await runtime.run({ id: 'trace-otlp-down', input: 'calculate 6*7' });
        expect(result.status).toBe('ok');
        traceId = result.traceId!;
        await expect(handle.flush()).resolves.toBeUndefined();
        await expect(handle.shutdown()).resolves.toBeUndefined();
      } finally {
        await handle.shutdown();
      }
    } finally {
      warnSpy.mockRestore();
      if (saved.endpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved.endpoint;
      if (saved.pk === undefined) delete process.env.LANGFUSE_PUBLIC_KEY;
      else process.env.LANGFUSE_PUBLIC_KEY = saved.pk;
      if (saved.sk === undefined) delete process.env.LANGFUSE_SECRET_KEY;
      else process.env.LANGFUSE_SECRET_KEY = saved.sk;
    }

    expect(traceId).toBeDefined();
    expect(existsSync(path.join(traceDir, `${traceId}.jsonl`))).toBe(true);
    expect(warnings.some((w) => w.startsWith('[tracing] OTLP export failed:'))).toBe(true);
    // The sanitized warning must not leak the Langfuse keys or the Basic auth header.
    expect(warnings.join('\n')).not.toMatch(/pk-test-dummy|sk-test-dummy|Basic /);
  });
});
