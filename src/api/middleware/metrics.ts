import { Request, Response, NextFunction } from "express";
import client from "prom-client";

export const register = new client.Registry();

const httpRequestDurationMs = new client.Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request duration in milliseconds",
  labelNames: ["method", "route", "status"],
  buckets: [5, 10, 25, 50, 100, 200, 500, 1000, 2000],
});

const httpRequestCount = new client.Counter({
  name: "http_request_count",
  help: "HTTP request count",
  labelNames: ["method", "route", "status"],
});

register.registerMetric(httpRequestDurationMs);
register.registerMetric(httpRequestCount);

client.collectDefaultMetrics({ register });

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on("finish", () => {
    const route = (req.route && req.route.path) || req.path || "unknown";
    const labels = { method: req.method, route, status: String(res.statusCode) } as const;
    httpRequestCount.inc(labels);
    httpRequestDurationMs.observe(labels, Date.now() - start);
  });
  next();
}
