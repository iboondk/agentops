import { z } from 'zod';
import { AgentError } from '../core/errors.js';
import { defineTool } from './registry.js';

type Op = '+' | '-' | '*' | '/' | '%' | '^' | 'neg';

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; op: Op }
  | { kind: 'lp' }
  | { kind: 'rp' };

const PRECEDENCE: Record<Op, number> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  '%': 2,
  neg: 3,
  '^': 4,
};

const RIGHT_ASSOC: Partial<Record<Op, true>> = { '^': true, neg: true };

function syntaxError(msg: string): AgentError {
  return new AgentError(`Syntax error: ${msg}`);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (!m) throw syntaxError(`invalid number at position ${i}`);
      tokens.push({ kind: 'num', value: Number(m[1]) });
      i += m[1]!.length;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lp' });
    } else if (ch === ')') {
      tokens.push({ kind: 'rp' });
    } else if ('+-*/%^'.includes(ch)) {
      tokens.push({ kind: 'op', op: ch as Op });
    } else {
      throw syntaxError(`unexpected character "${ch}" at position ${i}`);
    }
    i += 1;
  }
  return tokens;
}

/** Shunting-yard: infix tokens -> RPN tokens. Unary minus becomes op 'neg'. */
function toRpn(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const stack: Token[] = [];
  let expectOperand = true;

  for (const t of tokens) {
    if (t.kind === 'num') {
      if (!expectOperand) throw syntaxError('missing operator before number');
      output.push(t);
      expectOperand = false;
    } else if (t.kind === 'lp') {
      if (!expectOperand) throw syntaxError('missing operator before "("');
      stack.push(t);
    } else if (t.kind === 'rp') {
      if (expectOperand) throw syntaxError('unexpected ")"');
      while (stack.length > 0 && stack[stack.length - 1]!.kind !== 'lp') {
        output.push(stack.pop()!);
      }
      if (stack.length === 0) throw syntaxError('unbalanced parentheses');
      stack.pop();
      expectOperand = false;
    } else {
      let op = t.op;
      if (expectOperand) {
        // Prefix position: only unary minus and unary plus are valid.
        if (op === '-') {
          stack.push({ kind: 'op', op: 'neg' });
          continue;
        }
        if (op === '+') continue;
        throw syntaxError(`unexpected operator "${op}"`);
      }
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        if (top.kind !== 'op') break;
        const pTop = PRECEDENCE[top.op];
        const pCur = PRECEDENCE[op];
        if (pTop > pCur || (pTop === pCur && !RIGHT_ASSOC[op])) {
          output.push(stack.pop()!);
        } else {
          break;
        }
      }
      stack.push({ kind: 'op', op });
      expectOperand = true;
    }
  }

  if (expectOperand) throw syntaxError('unexpected end of expression');
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (top.kind === 'lp') throw syntaxError('unbalanced parentheses');
    output.push(top);
  }
  return output;
}

function evaluateRpn(rpn: Token[]): number {
  const st: number[] = [];
  for (const t of rpn) {
    if (t.kind === 'num') {
      st.push(t.value);
      continue;
    }
    if (t.kind !== 'op') throw syntaxError('unbalanced parentheses');
    if (t.op === 'neg') {
      if (st.length < 1) throw syntaxError('missing operand');
      st.push(-st.pop()!);
      continue;
    }
    if (st.length < 2) throw syntaxError('missing operand');
    const b = st.pop()!;
    const a = st.pop()!;
    switch (t.op) {
      case '+':
        st.push(a + b);
        break;
      case '-':
        st.push(a - b);
        break;
      case '*':
        st.push(a * b);
        break;
      case '/':
      case '%':
        if (b === 0) throw new AgentError('Division by zero');
        st.push(t.op === '/' ? a / b : a % b);
        break;
      case '^':
        st.push(a ** b);
        break;
    }
  }
  if (st.length !== 1) throw syntaxError('malformed expression');
  const result = st[0]!;
  if (!Number.isFinite(result)) throw new AgentError('Result is not a finite number');
  return result;
}

/** Safely evaluates arithmetic. Supports decimals, + - * / % ^, parentheses and unary minus. No eval. */
export function evaluateExpression(expression: string): number {
  return evaluateRpn(toRpn(tokenize(expression)));
}

export const calculatorTool = defineTool({
  name: 'calculator',
  description:
    'Evaluate an arithmetic expression. Supports numbers (decimals), + - * / % ^, parentheses and unary minus.',
  schema: z.object({ expression: z.string().max(200) }),
  timeoutMs: 1000,
  run: async ({ expression }) => String(evaluateExpression(expression)),
});
