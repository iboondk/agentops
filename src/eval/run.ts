import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentRuntime } from '../agent/runtime.js';
import type { RunResult } from '../core/types.js';
import { MockProvider } from '../llm/mockProvider.js';
import { createDefaultRegistry } from '../tools/index.js';
import { initTracing } from '../tracing/tracer.js';
import { CASES, FAKE_FETCH_BODY, type EvalCase } from './cases.js';

export interface Row {
  id: string;
  status: RunResult['status'];
  pass: boolean;
  reasons: string[];
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  traceId: string;
}

export interface EvalResult {
  passed: number;
  failed: number;
  rows: Row[];
}

const PROVIDER_LABEL = 'MockProvider (deterministic, offline)';
const PRICE_NOTE = 'Prices for mock-* models are illustrative, from src/config/pricing.ts.';
const SANDBOX_DIR = fileURLToPath(new URL('../../sandbox', import.meta.url));

/** Offline stand-in for fetch. Only http://example.test/ URLs resolve; nothing touches the network. */
const fakeFetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://example.test/')) {
    return new Response(`${FAKE_FETCH_BODY} for ${url}`, { status: 200 });
  }
  return new Response('fake fetch: unknown host', { status: 404 });
}) as typeof fetch;

function judge(c: EvalCase, result: RunResult): string[] {
  const reasons: string[] = [];
  if (result.status !== c.expect.status) {
    reasons.push(`status ${result.status} != expected ${c.expect.status}`);
  }
  for (const needle of c.expect.outputIncludes ?? []) {
    if (!result.output.includes(needle)) reasons.push(`output missing "${needle}"`);
  }
  const used = new Set(result.toolCalls.map((t) => t.name));
  for (const tool of c.expect.toolsUsed ?? []) {
    if (!used.has(tool)) reasons.push(`tool "${tool}" not used`);
  }
  if (c.expect.maxCostUsd !== undefined && result.costUsd > c.expect.maxCostUsd) {
    reasons.push(`cost ${result.costUsd} > max ${c.expect.maxCostUsd}`);
  }
  if (!result.traceId) reasons.push('no trace id');
  return reasons;
}

function money(usd: number): string {
  return usd.toFixed(6);
}

function renderMarkdown(rows: Row[], passed: number, failed: number, generatedAt: string): string {
  const passing = rows.filter((r) => r.pass);
  const totalCost = rows.reduce((n, r) => n + r.costUsd, 0);
  const meanPassing = passing.length > 0 ? passing.reduce((n, r) => n + r.costUsd, 0) / passing.length : 0;
  const lines: string[] = [
    '# Cost per task (regression eval)',
    '',
    `- Date: ${generatedAt.slice(0, 10)} (generated ${generatedAt})`,
    `- Provider: ${PROVIDER_LABEL}`,
    `- ${PRICE_NOTE}`,
    '- Token counts are recorded by the runtime; cost = tokens x pricing table. Duration is wall-clock on the machine that ran the eval.',
    '- Command: `npm run eval`',
    '',
    `Result: ${passed} passed, ${failed} failed, ${rows.length} cases.`,
    '',
    '| case | status | pass | steps | in tok | out tok | cost (USD, 6dp) | duration ms | trace id |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.status} | ${r.pass ? 'yes' : 'no'} | ${r.steps} | ${r.inputTokens} | ${r.outputTokens} | ${money(r.costUsd)} | ${r.durationMs} | \`${r.traceId}\` |`,
    );
  }
  lines.push(
    `| **total** (${rows.length}) | | ${passed}/${rows.length} | ${rows.reduce((n, r) => n + r.steps, 0)} | ${rows.reduce((n, r) => n + r.inputTokens, 0)} | ${rows.reduce((n, r) => n + r.outputTokens, 0)} | ${money(totalCost)} | ${rows.reduce((n, r) => n + r.durationMs, 0)} | |`,
  );
  lines.push('');
  lines.push(
    `Mean cost per passing task: ${money(meanPassing)} USD (over ${passing.length} passing case${passing.length === 1 ? '' : 's'}).`,
  );

  const failing = rows.filter((r) => !r.pass);
  if (failing.length > 0) {
    lines.push('', '## Failures', '');
    for (const r of failing) lines.push(`- ${r.id}: ${r.reasons.join('; ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Runs every case in CASES against MockProvider with an injected fake fetch. Each case gets its
 * own AgentRuntime and therefore its own trace (written as JSONL under traceDir). Writes
 * cost-per-task.json and cost-per-task.md into outDir.
 */
export async function runEval(opts: { traceDir?: string; outDir?: string } = {}): Promise<EvalResult> {
  const outDir = opts.outDir ?? 'reports';
  const tracing = initTracing({ dir: opts.traceDir, serviceName: 'agentops-eval' });
  const registry = createDefaultRegistry({ sandboxDir: SANDBOX_DIR, fetchImpl: fakeFetch });

  const rows: Row[] = [];
  try {
    for (const c of CASES) {
      const provider = new MockProvider({
        model: c.model ?? 'mock-small',
        failFirstN: c.providerOpts?.failFirstN,
      });
      const runtime = new AgentRuntime({
        provider,
        registry,
        budget: c.budget,
        maxSteps: c.maxSteps,
        tracer: tracing.tracer,
      });
      const result = await runtime.run({ id: c.id, input: c.input });
      const reasons = judge(c, result);
      rows.push({
        id: c.id,
        status: result.status,
        pass: reasons.length === 0,
        reasons,
        steps: result.steps,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        traceId: result.traceId ?? '',
      });
    }
  } finally {
    await tracing.shutdown();
  }

  const passed = rows.filter((r) => r.pass).length;
  const failed = rows.length - passed;
  const generatedAt = new Date().toISOString();

  mkdirSync(outDir, { recursive: true });
  const passingRows = rows.filter((r) => r.pass);
  const report = {
    generatedAt,
    provider: PROVIDER_LABEL,
    pricingNote: PRICE_NOTE,
    cases: rows.length,
    passed,
    failed,
    totals: {
      steps: rows.reduce((n, r) => n + r.steps, 0),
      inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
      costUsd: rows.reduce((n, r) => n + r.costUsd, 0),
      durationMs: rows.reduce((n, r) => n + r.durationMs, 0),
    },
    meanCostPerPassingTaskUsd:
      passingRows.length > 0 ? passingRows.reduce((n, r) => n + r.costUsd, 0) / passingRows.length : 0,
    rows,
  };
  writeFileSync(path.join(outDir, 'cost-per-task.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(path.join(outDir, 'cost-per-task.md'), renderMarkdown(rows, passed, failed, generatedAt));

  return { passed, failed, rows };
}

function printTable(rows: Row[]): void {
  console.log('case | status | pass | steps | in tok | out tok | cost (USD) | duration ms | trace id');
  for (const r of rows) {
    console.log(
      [r.id, r.status, r.pass ? 'yes' : 'no', r.steps, r.inputTokens, r.outputTokens, money(r.costUsd), r.durationMs, r.traceId].join(' | '),
    );
    for (const reason of r.reasons) console.log(`    - ${reason}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runEval()
    .then((res) => {
      printTable(res.rows);
      console.log(`\n${res.passed} passed, ${res.failed} failed. Reports written to reports/cost-per-task.{md,json}`);
      process.exitCode = res.failed > 0 ? 1 : 0;
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    });
}
