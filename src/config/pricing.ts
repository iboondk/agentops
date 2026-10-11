import type { Usage } from '../core/types.js';
import { AgentError } from '../core/errors.js';

export interface Price {
  /** USD per 1,000,000 input tokens. */
  inputPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMTok: number;
  /** True when the number is a placeholder, not a real provider price. */
  illustrative: boolean;
}

// IMPORTANT: real model prices must be copied from the provider's official pricing
// docs and dated in a comment next to the entry. Never guess or estimate them.
// Entries marked `illustrative: true` are for the offline mock provider only and
// are labelled as such in every generated cost report.
export const PRICING: Record<string, Price> = {
  'mock-small': { inputPerMTok: 1, outputPerMTok: 5, illustrative: true },
  'mock-large': { inputPerMTok: 3, outputPerMTok: 15, illustrative: true },
};

/** Returns the USD cost of `usage` for `model`. Throws AgentError for unknown models. */
export function costOf(usage: Usage, model: string): number {
  const price = PRICING[model];
  if (!price) {
    throw new AgentError(`No pricing configured for model "${model}"`);
  }
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok
  );
}
