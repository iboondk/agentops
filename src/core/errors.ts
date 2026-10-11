export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

export class TimeoutError extends AgentError {
  readonly ms: number;

  constructor(message: string, ms: number) {
    super(message);
    this.name = 'TimeoutError';
    this.ms = ms;
  }
}

export class BudgetExceededError extends AgentError {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = 'BudgetExceededError';
    this.reason = reason;
  }
}

export class RetryableError extends AgentError {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}
