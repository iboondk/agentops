import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SpanStatusCode, type HrTime } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

/** One finished span as written to a `<traceId>.jsonl` line. */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: 'ok' | 'error';
  attributes: Record<string, unknown>;
  events: { name: string; timeMs: number; attributes: Record<string, unknown> }[];
}

function hrTimeToMs(t: HrTime): number {
  return t[0] * 1_000 + t[1] / 1_000_000;
}

/** Converts an OpenTelemetry ReadableSpan into the flat record shape used by the JSONL files and the UI. */
export function toRecord(span: ReadableSpan): SpanRecord {
  const ctx = span.spanContext();
  const startMs = hrTimeToMs(span.startTime);
  const endMs = hrTimeToMs(span.endTime);
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    status: span.status.code === SpanStatusCode.ERROR ? 'error' : 'ok',
    attributes: { ...span.attributes },
    events: span.events.map((e) => ({
      name: e.name,
      timeMs: hrTimeToMs(e.time),
      attributes: { ...(e.attributes ?? {}) },
    })),
  };
}

/** Appends one JSON line per finished span to `${dir}/${traceId}.jsonl`. */
export class JsonlSpanExporter implements SpanExporter {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    let result: ExportResult = { code: ExportResultCode.SUCCESS };
    try {
      mkdirSync(this.dir, { recursive: true });
      const linesByTrace = new Map<string, string[]>();
      for (const span of spans) {
        const record = toRecord(span);
        const lines = linesByTrace.get(record.traceId) ?? [];
        lines.push(JSON.stringify(record));
        linesByTrace.set(record.traceId, lines);
      }
      for (const [traceId, lines] of linesByTrace) {
        appendFileSync(path.join(this.dir, `${traceId}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
      }
    } catch (err) {
      result = {
        code: ExportResultCode.FAILED,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    resultCallback(result);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** In-memory exporter for tests. Keeps every exported span as a SpanRecord. */
export class MemorySpanExporter implements SpanExporter {
  private readonly stored: SpanRecord[] = [];

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) this.stored.push(toRecord(span));
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /** Copy of all records exported so far, in export order. */
  get records(): SpanRecord[] {
    return [...this.stored];
  }

  reset(): void {
    this.stored.length = 0;
  }
}
