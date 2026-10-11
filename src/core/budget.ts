import type { Usage } from './types.js';
import { costOf } from '../config/pricing.js';
import { BudgetExceededError } from './errors.js';

export interface BudgetLimits {
  maxUsd?: number;
  maxTokens?: number;
  maxSteps?: number;
}

export class Budget {
  private readonly limits: BudgetLimits;
  private readonly model: string;
  private inputTokens = 0;
  private outputTokens = 0;
  private usd = 0;
  private stepCount = 0;

  constructor(limits: BudgetLimits, model: string) {
    this.limits = limits;
    this.model = model;
  }

  record(usage: Usage): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.usd += costOf(usage, this.model);
  }

  step(): void {
    this.stepCount += 1;
  }

  get usage(): Usage {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }

  get costUsd(): number {
    return this.usd;
  }

  get steps(): number {
    return this.stepCount;
  }

  /** Returns the first exceeded limit ('usd' | 'tokens' | 'steps'), or null. Strictly over only. */
  exceeded(): string | null {
    const { maxUsd, maxTokens, maxSteps } = this.limits;
    if (maxUsd !== undefined && this.usd > maxUsd) return 'usd';
    if (maxTokens !== undefined && this.inputTokens + this.outputTokens > maxTokens) return 'tokens';
    if (maxSteps !== undefined && this.stepCount > maxSteps) return 'steps';
    return null;
  }

  assertWithin(): void {
    const reason = this.exceeded();
    if (reason !== null) {
      throw new BudgetExceededError(`Budget exceeded: ${reason}`, reason);
    }
  }
}
