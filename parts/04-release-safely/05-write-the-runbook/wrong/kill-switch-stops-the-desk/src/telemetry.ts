// OpenTelemetry: one trace per run.
// Spans go over OTLP/HTTP (JSON) to the trace desk, or to any collector.
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
    // Send finished spans in batches every half second, instead of one request per span.
    new BatchSpanProcessor({
      exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      scheduledDelayMillis: 500,
    }),
  ],
});
// The context manager lets a span started in one await find its parent span after the await.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(provider);
export const tracer = trace.getTracer("permit-desk");

type SpanAttributes = Record<string, string | number | boolean>;

/** Do the work inside a child span, and mark the span as an error when the work throws. */
export async function inChildSpan<Result>(
  name: string,
  attributes: SpanAttributes,
  work: (span: Span) => Promise<Result>,
): Promise<Result> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
