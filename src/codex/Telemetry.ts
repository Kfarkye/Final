import {
  SpanContext,
  context as otelContext,
  metrics,
  Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { SpanLike, Telemetry } from "./types.js";

/**
 * OpenTelemetry-backed Telemetry implementation.
 *
 * SOC2 logging contract: callers pass only safe attributes (ids, methods,
 * counts, states). This layer NEVER serializes raw turn inputs or payloads.
 */
export class OtelTelemetry implements Telemetry {
  private readonly tracer = trace.getTracer("codex-client");
  private readonly meter = metrics.getMeter("codex-client");

  private readonly counters = new Map<
    string,
    ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>
  >();
  private readonly gauges = new Map<string, number>();
  private readonly observableGauges = new Set<string>();

  startSpan(
    name: string,
    attrs: Record<string, string | number | boolean>,
  ): SpanLike {
    const span: Span = this.tracer.startSpan(name, { attributes: attrs });
    return new OtelSpan(span);
  }

  counterAdd(name: string, value: number, attrs?: Record<string, string>): void {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    counter.add(value, attrs);
  }

  gaugeSet(name: string, value: number, attrs?: Record<string, string>): void {
    this.gauges.set(this.gaugeKey(name, attrs), value);
    if (!this.observableGauges.has(name)) {
      this.observableGauges.add(name);
      const g = this.meter.createObservableGauge(name);
      g.addCallback((result) => {
        this.gauges.forEach((v, key) => {
          if (!key.startsWith(`${name}|`)) return;
          result.observe(v, this.decodeAttrs(key));
        });
      });
    }
  }

  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    attrs?: Record<string, unknown>,
  ): void {
    // Structured JSON to stdout — ingested by the K8s log pipeline.
    // Defensive scrub: drop any obviously sensitive keys if a caller slips.
    const safe = scrub(attrs ?? {});
    const span = trace.getSpan(otelContext.active());
    const sc: SpanContext | undefined = span?.spanContext();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      traceId: sc?.traceId,
      spanId: sc?.spanId,
      ...safe,
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  private gaugeKey(name: string, attrs?: Record<string, string>): string {
    return `${name}|${JSON.stringify(attrs ?? {})}`;
  }
  private decodeAttrs(key: string): Record<string, string> {
    const json = key.slice(key.indexOf("|") + 1);
    try {
      return JSON.parse(json) as Record<string, string>;
    } catch {
      return {};
    }
  }
}

class OtelSpan implements SpanLike {
  constructor(private readonly span: Span) {}
  setAttribute(key: string, value: string | number | boolean): void {
    this.span.setAttribute(key, value);
  }
  recordException(err: Error): void {
    this.span.recordException(err);
  }
  setStatusError(message: string): void {
    this.span.setStatus({ code: SpanStatusCode.ERROR, message });
  }
  end(): void {
    this.span.end();
  }
}

const SENSITIVE_KEYS = /input|payload|text|prompt|content|message|secret|token|password/i;
function scrub(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      out[k] = "[object]"; // never deep-serialize unknown objects
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** No-op telemetry for tests / local dev. */
export class NoopTelemetry implements Telemetry {
  startSpan(): SpanLike {
    return {
      setAttribute: () => {},
      recordException: () => {},
      setStatusError: () => {},
      end: () => {},
    };
  }
  counterAdd(): void {}
  gaugeSet(): void {}
  log(): void {}
}
