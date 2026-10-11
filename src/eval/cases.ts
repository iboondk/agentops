import type { BudgetLimits } from '../core/budget.js';
import type { RunStatus } from '../core/types.js';

export interface EvalCase {
  id: string;
  input: string;
  expect: {
    status: RunStatus;
    /** Substrings that must appear in the final output. */
    outputIncludes?: string[];
    /** Tool names that must have been called at least once. */
    toolsUsed?: string[];
    /** Upper bound on the run's USD cost. */
    maxCostUsd?: number;
  };
  budget?: BudgetLimits;
  model?: string;
  /** Overrides the runtime step limit (default 6). Needed to exercise status `max_steps`. */
  maxSteps?: number;
  providerOpts?: { failFirstN?: number };
}

/** Body returned by the injected fake fetch for any http://example.test/ URL. */
export const FAKE_FETCH_BODY = 'example fixed body';

export const CASES: EvalCase[] = [
  {
    id: 'arithmetic',
    input: 'calculate 12*(3+4)',
    expect: {
      status: 'ok',
      outputIncludes: ['84'],
      toolsUsed: ['calculator'],
      maxCostUsd: 0.001,
    },
  },
  {
    id: 'precedence_unary',
    input: 'calculate 2^3^2 + -3*-2',
    expect: {
      status: 'ok',
      // ^ is right-associative (2^(3^2) = 512); unary minus binds to its operand (-3 * -2 = 6).
      outputIncludes: ['518'],
      toolsUsed: ['calculator'],
    },
  },
  {
    id: 'fs_search_hit',
    input: 'search for failover',
    expect: {
      status: 'ok',
      outputIncludes: ['runbook.md'],
      toolsUsed: ['fs_search'],
    },
  },
  {
    id: 'fs_search_no_match',
    input: 'search for zzz-no-such-term',
    expect: {
      status: 'ok',
      outputIncludes: ['no matches'],
      toolsUsed: ['fs_search'],
    },
  },
  {
    id: 'http_fetch_fake',
    input: 'fetch http://example.test/status',
    expect: {
      status: 'ok',
      outputIncludes: ['status: 200', FAKE_FETCH_BODY],
      toolsUsed: ['http_fetch'],
    },
  },
  {
    id: 'llm_transient_retry',
    input: 'calculate 5+5',
    providerOpts: { failFirstN: 1 },
    expect: {
      status: 'ok',
      outputIncludes: ['10'],
      toolsUsed: ['calculator'],
    },
  },
  {
    id: 'budget_exceeded',
    input: 'calculate 1+1',
    budget: { maxUsd: 1e-9 },
    expect: {
      status: 'budget_exceeded',
    },
  },
  {
    id: 'max_steps',
    input: 'calculate 1+1',
    maxSteps: 1,
    expect: {
      status: 'max_steps',
      toolsUsed: ['calculator'],
    },
  },
  {
    id: 'mock_large_arithmetic',
    input: 'calculate 12*(3+4)',
    model: 'mock-large',
    expect: {
      status: 'ok',
      outputIncludes: ['84'],
      toolsUsed: ['calculator'],
    },
  },
  {
    id: 'no_tool_summary',
    input: 'hello agentops',
    expect: {
      status: 'ok',
      outputIncludes: ['Summary: hello agentops'],
    },
  },
];
