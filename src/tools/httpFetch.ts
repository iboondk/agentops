import { z } from 'zod';
import { AgentError, RetryableError } from '../core/errors.js';
import { defineTool } from './registry.js';

export const HTTP_FETCH_MAX_CHARS = 100_000;

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/** Reads at most `maxChars` characters from the response body, then cancels the rest. */
async function readLimited(res: Response, maxChars: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (out.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) {
        out += decoder.decode();
        break;
      }
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.slice(0, maxChars);
}

/**
 * Factory so tests can inject a fake fetch. Production uses the global fetch.
 * Only http/https; optional host allowlist via HTTP_FETCH_ALLOWLIST (comma-separated).
 */
export function createHttpFetchTool(fetchImpl: typeof fetch = fetch) {
  return defineTool({
    name: 'http_fetch',
    description: `HTTP GET a http/https URL. Returns "status: <code>" and up to ${HTTP_FETCH_MAX_CHARS} characters of body.`,
    schema: z.object({ url: z.string().url() }),
    timeoutMs: 8000,
    retries: 2,
    run: async ({ url }, { signal }) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new AgentError(`Protocol not allowed: ${parsed.protocol}`);
      }

      const allowlist = parseAllowlist(process.env.HTTP_FETCH_ALLOWLIST);
      if (allowlist.length > 0 && !allowlist.includes(parsed.hostname.toLowerCase())) {
        throw new AgentError(`Host not in HTTP_FETCH_ALLOWLIST: ${parsed.hostname}`);
      }

      let res: Response;
      try {
        res = await fetchImpl(url, { signal, method: 'GET' });
      } catch (err) {
        if (signal.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new RetryableError(`network error: ${msg}`);
      }

      if (res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        throw new RetryableError(`server error: status ${res.status}`);
      }

      const body = await readLimited(res, HTTP_FETCH_MAX_CHARS);
      return `status: ${res.status}\n\n${body}`;
    },
  });
}

export const httpFetchTool = createHttpFetchTool();
