import { existsSync, readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runEval } from '../src/eval/run.js';

const baseDir = './data/tmp-eval';

describe('regression eval suite', () => {
  it('passes every case, writes one trace per case, and reports the budget case as budget_exceeded', async () => {
    rmSync(baseDir, { recursive: true, force: true });
    const outDir = `${baseDir}/reports`;

    const res = await runEval({ traceDir: `${baseDir}/traces`, outDir });

    expect(res.failed).toBe(0);
    expect(res.rows.length).toBeGreaterThanOrEqual(8);
    for (const row of res.rows) {
      expect(row.costUsd).toBeGreaterThanOrEqual(0);
      expect(row.traceId).toBeTruthy();
    }
    const budget = res.rows.find((r) => r.id === 'budget_exceeded');
    expect(budget?.status).toBe('budget_exceeded');

    expect(existsSync(`${outDir}/cost-per-task.md`)).toBe(true);
    expect(existsSync(`${outDir}/cost-per-task.json`)).toBe(true);
    const md = readFileSync(`${outDir}/cost-per-task.md`, 'utf8');
    expect(md).toContain('Prices for mock-* models are illustrative, from src/config/pricing.ts.');

    rmSync(baseDir, { recursive: true, force: true });
  }, 60_000); // runs 10 cases with a JSONL write per span; slow disks need more than the 10 s default
});
