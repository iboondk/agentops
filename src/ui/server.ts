import http from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpanRecord } from '../tracing/jsonlExporter.js';

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const INDEX_HTML = fileURLToPath(new URL('./public/index.html', import.meta.url));

export interface TraceSummary {
  traceId: string;
  rootName: string;
  status: 'ok' | 'error';
  startMs: number;
  durationMs: number;
  costUsd: number;
  spanCount: number;
}

function readSpans(file: string): SpanRecord[] {
  const spans: SpanRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      spans.push(JSON.parse(line) as SpanRecord);
    } catch {
      // Skip a malformed line rather than failing the whole listing.
    }
  }
  return spans;
}

/** Summarises one trace: root span name/status, wall-clock span, and cost from the agent.run span. */
function summarise(traceId: string, spans: SpanRecord[]): TraceSummary | null {
  if (spans.length === 0) return null;
  const root = spans.find((s) => s.parentSpanId === null) ?? spans[0]!;
  const startMs = Math.min(...spans.map((s) => s.startMs));
  const endMs = Math.max(...spans.map((s) => s.endMs));
  const agentCost = root.attributes['agent.cost_usd'];
  const costUsd =
    typeof agentCost === 'number'
      ? agentCost
      : spans.reduce((sum, s) => sum + (Number(s.attributes['llm.cost_usd']) || 0), 0);
  return {
    traceId,
    rootName: root.name,
    // The run outcome: a failed tool inside a run that still answered is not a failed run.
    status: root.status,
    startMs,
    durationMs: endMs - startMs,
    costUsd,
    spanCount: spans.length,
  };
}

function listTraces(traceDir: string): TraceSummary[] {
  if (!existsSync(traceDir)) return [];
  const summaries: TraceSummary[] = [];
  for (const entry of readdirSync(traceDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const traceId = entry.slice(0, -'.jsonl'.length);
    if (!TRACE_ID_RE.test(traceId)) continue;
    const summary = summarise(traceId, readSpans(path.join(traceDir, entry)));
    if (summary) summaries.push(summary);
  }
  return summaries.sort((a, b) => b.startMs - a.startMs);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendNotFound(res: http.ServerResponse): void {
  sendJson(res, 404, { error: 'not found' });
}

/**
 * Read-only HTTP server for the local trace UI.
 *   GET /ui                 -> src/ui/public/index.html
 *   GET /api/traces         -> trace summaries, newest first
 *   GET /api/traces/:id     -> span records for one trace (id must be 32 lowercase hex chars)
 */
export function createUiServer(traceDir: string): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (req.method !== 'GET') {
      sendNotFound(res);
      return;
    }

    if (pathname === '/ui') {
      try {
        const html = readFileSync(INDEX_HTML, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
      } catch {
        sendNotFound(res);
      }
      return;
    }

    if (pathname === '/api/traces') {
      sendJson(res, 200, listTraces(traceDir));
      return;
    }

    const match = /^\/api\/traces\/([^/]+)$/.exec(pathname);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      if (!TRACE_ID_RE.test(id)) {
        sendJson(res, 400, { error: 'trace id must be 32 lowercase hex characters' });
        return;
      }
      const file = path.join(traceDir, `${id}.jsonl`);
      if (!existsSync(file)) {
        sendNotFound(res);
        return;
      }
      const spans = readSpans(file).sort((a, b) => a.startMs - b.startMs);
      sendJson(res, 200, spans);
      return;
    }

    sendNotFound(res);
  });
}

// Run directly: `npm run ui` starts the server on UI_PORT (default 4318).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.UI_PORT ?? 4318);
  // Default is loopback only. Docker Compose sets UI_HOST=0.0.0.0 so the published port is reachable.
  const host = process.env.UI_HOST ?? '127.0.0.1';
  const traceDir = process.env.TRACE_DIR ?? './data/traces';
  const server = createUiServer(traceDir);
  server.listen(port, host, () => {
    console.log(`Trace UI: http://localhost:${port}/ui  (traces from ${path.resolve(traceDir)})`);
  });
}
