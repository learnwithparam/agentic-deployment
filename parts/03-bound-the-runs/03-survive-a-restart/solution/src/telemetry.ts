// OpenTelemetry: the desk's tracer. It sends finished spans to the trace desk over OTLP/HTTP,
// as JSON. This file is ready. Nothing starts a span yet: that is your job in src/agent.ts.
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { release } from "./config";

// Inside the Docker network the trace desk is called "traces". Any OTLP collector works too.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://traces:7004";

const provider = new TracerProvider({
  // Every span from this desk says which service and which release made it.
  resource: resourceFromAttributes({
    "service.name": "permit-desk",
    "service.version": release.id,
  }),
  spanProcessors: [
    // Send finished spans in batches every half second, instead of one request per span.
    new BatchSpanProcessor({
      exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      scheduledDelayMillis: 500,
    }),
  ],
});

// The context manager lets a span started after an await still find its parent span.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(provider);

export const tracer = trace.getTracer("permit-desk");

type SpanAttributes = Record<string, string | number | boolean>;

/**
 * Do the work inside a new span, then end the span. The new span's parent is the span that is
 * active now. When the work throws, the span is marked as an error.
 */
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

// Send the last spans to the trace desk before the container stops.
process.on("SIGTERM", async () => {
  await provider.forceFlush();
  process.exit(0);
});
