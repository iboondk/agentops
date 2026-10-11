import { trace, type Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { JsonlSpanExporter } from './jsonlExporter.js';

export interface InitTracingOptions {
  /** Directory for `<traceId>.jsonl` files. Default: TRACE_DIR, then ./data/traces. */
  dir?: string;
  /** Extra exporters, each attached with its own SimpleSpanProcessor (e.g. MemorySpanExporter in tests). */
  exporters?: SpanExporter[];
  /** service.name resource attribute. Default: OTEL_SERVICE_NAME, then "agentops". */
  serviceName?: string;
}

export interface TracingHandle {
  tracer: Tracer;
  /** Flushes and stops every processor, then unregisters the global provider. */
  shutdown(): Promise<void>;
  /** Exports everything buffered by batch processors. */
  flush(): Promise<void>;
}

const TRACER_NAME = 'agentops';

/** Builds the OTLP/HTTP traces URL from a base endpoint, unless it already ends in /v1/traces. */
function otlpTracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
}

/**
 * Export is best-effort: an unreachable collector or Langfuse must never break the agent run or
 * the eval report. Logs one line with the error message only; headers and keys are never logged.
 */
function warnExportFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn('[tracing] OTLP export failed: ' + message);
}

/**
 * Langfuse OTLP auth: Basic base64(publicKey:secretKey). Returns no headers when either key is
 * missing. The header value is never logged.
 */
function langfuseHeaders(): Record<string, string> {
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;
  if (!pk || !sk) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${pk}:${sk}`).toString('base64') };
}

/**
 * Creates a BasicTracerProvider (OpenTelemetry SDK v2 constructor API), registers it globally,
 * and returns a tracer plus lifecycle helpers.
 *
 * - Always: JSONL files via SimpleSpanProcessor (each span is written when it ends).
 * - Extra `exporters` via their own SimpleSpanProcessor.
 * - When OTEL_EXPORTER_OTLP_ENDPOINT is set: OTLP/HTTP via BatchSpanProcessor. If
 *   LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are also set, the Basic auth header is added.
 */
export function initTracing(opts: InitTracingOptions = {}): TracingHandle {
  const dir = opts.dir ?? process.env.TRACE_DIR ?? './data/traces';
  const serviceName = opts.serviceName ?? process.env.OTEL_SERVICE_NAME ?? TRACER_NAME;

  const spanProcessors: SpanProcessor[] = [new SimpleSpanProcessor(new JsonlSpanExporter(dir))];
  for (const exporter of opts.exporters ?? []) {
    spanProcessors.push(new SimpleSpanProcessor(exporter));
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: otlpTracesUrl(endpoint),
          headers: langfuseHeaders(),
        }),
      ),
    );
  }

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors,
  });
  trace.setGlobalTracerProvider(provider);

  return {
    tracer: provider.getTracer(TRACER_NAME),
    async shutdown() {
      try {
        await provider.shutdown();
      } catch (err) {
        warnExportFailure(err);
      } finally {
        trace.disable();
      }
    },
    async flush() {
      try {
        await provider.forceFlush();
      } catch (err) {
        warnExportFailure(err);
      }
    },
  };
}
