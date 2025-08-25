import client from 'prom-client';
import { register as apiRegister } from '../api/middleware/metrics';

// Reuse the API metrics registry for a single /metrics endpoint
export const register = apiRegister;

// Hyperliquid HTTP metrics
const hlHttpLatency = new client.Histogram({
  name: 'hyperliquid_http_latency_ms',
  help: 'Latency of Hyperliquid HTTP calls',
  labelNames: ['endpoint', 'status'],
  buckets: [50, 100, 200, 400, 800, 1500, 3000, 5000, 10000],
});

const hlHttpCount = new client.Counter({
  name: 'hyperliquid_http_requests_total',
  help: 'Total Hyperliquid HTTP requests',
  labelNames: ['endpoint', 'status'],
});

// WS reconnects
const wsReconnects = new client.Counter({
  name: 'hyperliquid_ws_reconnects_total',
  help: 'Total number of WebSocket reconnect attempts',
});

// Execution metrics
const execOrderLatency = new client.Histogram({
  name: 'execution_order_latency_ms',
  help: 'Per-order execution latency until REST response',
  buckets: [20, 50, 100, 200, 400, 800, 1500, 3000, 5000, 10000],
});

const execOrders = new client.Counter({
  name: 'execution_orders_total',
  help: 'Execution orders by status and side',
  labelNames: ['status', 'side', 'reason'],
});

const execActiveTasks = new client.Gauge({
  name: 'execution_active_tasks',
  help: 'Number of active execution tasks',
});

const execQueueLength = new client.Gauge({
  name: 'execution_queue_length',
  help: 'Number of signals waiting in the queue',
});

register.registerMetric(hlHttpLatency);
register.registerMetric(hlHttpCount);
register.registerMetric(wsReconnects);
register.registerMetric(execOrderLatency);
register.registerMetric(execOrders);
register.registerMetric(execActiveTasks);
register.registerMetric(execQueueLength);

export function recordHttpRequest(endpoint: string, status: string, latencyMs: number) {
  const labels = { endpoint, status } as const;
  hlHttpCount.inc(labels);
  hlHttpLatency.observe(labels, latencyMs);
}

export function incWsReconnect() {
  wsReconnects.inc();
}

export function observeOrderLatency(ms: number) {
  execOrderLatency.observe(ms);
}

export function incOrder(status: 'success' | 'failed' | 'rejected', side: 'buy' | 'sell' | 'n/a', reason = '') {
  execOrders.inc({ status, side, reason });
}

export function setExecutionGauges(active: number, queueLen: number) {
  execActiveTasks.set(active);
  execQueueLength.set(queueLen);
}

// ===== Risk & Equity Metrics =====
const riskRejections = new client.Counter({
  name: 'risk_rejections_total',
  help: 'Total number of risk-based rejections',
  labelNames: ['reason'],
});

const circuitBreakerTrips = new client.Counter({
  name: 'circuit_breaker_trips_total',
  help: 'Number of times the circuit breaker was tripped',
  labelNames: ['reason'],
});

const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state: 1=tripped, 0=normal',
});

const equityLast = new client.Gauge({
  name: 'equity_last_usd',
  help: 'Last observed account equity in USD',
});

const equityPeak = new client.Gauge({
  name: 'equity_peak_usd',
  help: 'Peak observed account equity in USD',
});

const equityDailyBaseline = new client.Gauge({
  name: 'equity_daily_baseline_usd',
  help: 'Daily baseline equity at start of day in USD',
});

const drawdownGauge = new client.Gauge({
  name: 'drawdown_fraction',
  help: 'Current drawdown fraction (0-1) from peak equity',
});

const dailyLossGauge = new client.Gauge({
  name: 'daily_loss_usd',
  help: 'Current daily loss versus baseline in USD',
});

register.registerMetric(riskRejections);
register.registerMetric(circuitBreakerTrips);
register.registerMetric(circuitBreakerState);
register.registerMetric(equityLast);
register.registerMetric(equityPeak);
register.registerMetric(equityDailyBaseline);
register.registerMetric(drawdownGauge);
register.registerMetric(dailyLossGauge);

export function incRiskRejection(reason: string) {
  riskRejections.inc({ reason });
}

export function incCircuitBreakerTrip(reason: string) {
  circuitBreakerTrips.inc({ reason });
}

export function setCircuitBreakerState(on: boolean) {
  circuitBreakerState.set(on ? 1 : 0);
}

export function setEquityMetrics(equityUsd: number, peakUsd: number, baselineUsd: number) {
  equityLast.set(equityUsd);
  if (peakUsd > 0) equityPeak.set(peakUsd);
  if (baselineUsd > 0) equityDailyBaseline.set(baselineUsd);
}

export function setDrawdown(fraction: number) {
  drawdownGauge.set(Math.max(0, fraction));
}

export function setDailyLoss(usd: number) {
  dailyLossGauge.set(Math.max(0, usd));
}
