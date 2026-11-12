// OpenTelemetry: one trace per run. Spans go over OTLP/HTTP (JSON) to the trace desk, or to any collector.
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://traces:7004";
export const provider = new TracerProvider({
  resource: resourceFromAttributes({
    "service.name": "permit-desk",
    "service.version": process.env.SERVICE_VERSION ?? "finished",
  }),
  spanProcessors: [
    new BatchSpanProcessor({
      exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      scheduledDelayMillis: 500,
    }),
  ],
});
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(provider);
export const tracer = trace.getTracer("permit-desk");

/** Run fn inside a child span, and mark the span as an error when fn throws. */
export async function span<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (s: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (s) => {
    try {
      return await fn(s);
    } catch (e) {
      s.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      s.end();
    }
  });
}
