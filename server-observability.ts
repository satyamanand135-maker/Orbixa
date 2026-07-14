import crypto from "crypto";
import type { Express, NextFunction, Request, Response } from "express";

interface MetricsState {
  startedAt: number;
  requests: Map<string, number>;
  durations: Map<string, number[]>;
  errors: Map<string, number>;
}

export const metricsState: MetricsState = {
  startedAt: Date.now(),
  requests: new Map(),
  durations: new Map(),
  errors: new Map(),
};

function inc(map: Map<string, number>, key: string, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function labels(values: Record<string, string | number>) {
  return Object.entries(values).map(([key, value]) => `${key}="${String(value).replace(/"/g, "'")}"`).join(",");
}

export function logStructured(level: "info" | "warn" | "error", message: string, fields: Record<string, any> = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    service: "dhub-api",
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Gap 20 — Sentry Error Tracking
// Lazily initialized to avoid blocking startup if DSN is absent
// ---------------------------------------------------------------------------
let sentryHub: any = null;

async function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || sentryHub) return;
  try {
    const Sentry = await import("@sentry/node" as any);
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || "development",
      release: process.env.BUILD_SHA || "local",
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
      integrations: [Sentry.httpIntegration()],
    });
    sentryHub = Sentry;
    logStructured("info", "[Sentry] Initialized", { environment: process.env.NODE_ENV });
  } catch {
    logStructured("warn", "[Sentry] @sentry/node not installed — error tracking disabled");
  }
}

// Initialize on first import (non-blocking)
initSentry().catch(() => {});

export function captureError(error: any, fields: Record<string, any> = {}) {
  inc(metricsState.errors, fields.route || "unknown");
  logStructured("error", error?.message || "Unhandled error", {
    ...fields,
    stack: error?.stack,
    name: error?.name,
  });

  // Forward to Sentry if configured
  if (sentryHub) {
    try {
      sentryHub.withScope((scope: any) => {
        scope.setTag("route", fields.route || "unknown");
        scope.setTag("tenantId", fields.tenantId || "");
        scope.setExtras(fields);
        sentryHub.captureException(error instanceof Error ? error : new Error(String(error?.message || error)));
      });
    } catch {
      // Sentry failure must never affect the main application
    }
  }
}

export function observabilityMiddleware(req: Request, res: Response, next: NextFunction) {
  const started = Date.now();
  const requestId = req.get("x-request-id") || crypto.randomUUID();
  (req as any).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  res.on("finish", () => {
    const route = req.route?.path || req.path;
    const key = `${req.method} ${route} ${res.statusCode}`;
    const durationMs = Date.now() - started;
    inc(metricsState.requests, key);
    const durations = metricsState.durations.get(key) || [];
    durations.push(durationMs);
    if (durations.length > 200) durations.shift();
    metricsState.durations.set(key, durations);

    logStructured(res.statusCode >= 500 ? "error" : "info", "http_request", {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
    });
  });

  next();
}

export function renderPrometheusMetrics(): string {
  const lines: string[] = [];
  lines.push("# HELP dhub_process_uptime_seconds Process uptime in seconds");
  lines.push("# TYPE dhub_process_uptime_seconds gauge");
  lines.push(`dhub_process_uptime_seconds ${Math.round((Date.now() - metricsState.startedAt) / 1000)}`);

  lines.push("# HELP dhub_http_requests_total HTTP requests by method, route, and status");
  lines.push("# TYPE dhub_http_requests_total counter");
  for (const [key, count] of metricsState.requests.entries()) {
    const [method, route, status] = key.split(" ");
    lines.push(`dhub_http_requests_total{${labels({ method, route, status })}} ${count}`);
  }

  lines.push("# HELP dhub_http_request_duration_ms_avg Average HTTP duration in milliseconds");
  lines.push("# TYPE dhub_http_request_duration_ms_avg gauge");
  for (const [key, durations] of metricsState.durations.entries()) {
    const [method, route, status] = key.split(" ");
    const avg = durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length);
    lines.push(`dhub_http_request_duration_ms_avg{${labels({ method, route, status })}} ${avg.toFixed(2)}`);
  }

  lines.push("# HELP dhub_errors_total Captured application errors by route");
  lines.push("# TYPE dhub_errors_total counter");
  for (const [route, count] of metricsState.errors.entries()) {
    lines.push(`dhub_errors_total{${labels({ route })}} ${count}`);
  }

  return `${lines.join("\n")}\n`;
}

export function registerObservability(app: Express) {
  app.use(observabilityMiddleware);
  app.get("/metrics", async (_req, res) => {
    let output = renderPrometheusMetrics();

    // Include job-level queue metrics (lazy import to avoid circular dependency at startup)
    try {
      const { renderJobMetrics } = await import("./server-jobs.ts");
      output += renderJobMetrics();
    } catch {
      // server-jobs not yet initialized — skip
    }

    res.type("text/plain; version=0.0.4").send(output);
  });

  process.on("unhandledRejection", (error) => captureError(error, { route: "process.unhandledRejection" }));
  process.on("uncaughtException", (error) => captureError(error, { route: "process.uncaughtException" }));
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  documentId?: string;
  tenantId?: string;
  startTime: Date;
  attributes: Record<string, any>;
  status: "OK" | "ERROR";
  error?: string;
  setAttribute(key: string, value: any): void;
  end(): Promise<void>;
}

/**
 * Start a lightweight OpenTelemetry-compatible span.
 */
export function startSpan(
  name: string,
  documentId?: string,
  tenantId?: string,
  traceId?: string,
  parentSpanId?: string
): Span {
  const finalTraceId = traceId || `trace-${crypto.randomUUID()}`;
  const spanId = `span-${crypto.randomUUID()}`;
  const startTime = new Date();
  const attributes: Record<string, any> = {};

  return {
    traceId: finalTraceId,
    spanId,
    parentSpanId,
    name,
    documentId,
    tenantId,
    startTime,
    attributes,
    status: "OK",
    setAttribute(key: string, value: any) {
      this.attributes[key] = value;
    },
    async end() {
      const endTime = new Date();
      const durationMs = endTime.getTime() - this.startTime.getTime();
      
      // Log span in structured OpenTelemetry layout
      logStructured("info", `otel_span: ${this.name}`, {
        traceId: this.traceId,
        spanId: this.spanId,
        parentSpanId: this.parentSpanId,
        durationMs,
        status: this.status,
        documentId: this.documentId,
        tenantId: this.tenantId,
        attributes: this.attributes,
        error: this.error,
      });

      // Save to MongoDB (dynamic import to prevent circular dependency)
      try {
        const { TraceSpan } = await import("./server-db.ts");
        // Only write to MongoDB if we are not in test mode, or if state is running
        if (process.env.NODE_ENV !== "test") {
          await TraceSpan.create({
            traceId: this.traceId,
            spanId: this.spanId,
            parentSpanId: this.parentSpanId,
            name: this.name,
            documentId: this.documentId,
            tenantId: this.tenantId,
            startTime: this.startTime,
            endTime,
            durationMs,
            attributes: this.attributes,
            status: this.status,
            error: this.error,
          });
        }
      } catch (err: any) {
        console.error("Failed to persist OpenTelemetry span to database:", err.message);
      }
    }
  };
}