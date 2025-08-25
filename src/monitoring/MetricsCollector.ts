/**
 * MetricsCollector - Central metrics aggregation service
 * Collects metrics from all components and provides Prometheus-compatible export
 */

import { EventEmitter } from 'events';
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import winston from 'winston';

export interface SystemMetrics {
  timestamp: number;
  
  // Performance metrics
  latency: {
    signalGeneration: number;
    signalTransformation: number;
    orderExecution: number;
    riskCheck: number;
    total: number;
  };
  
  // Trading metrics
  trading: {
    signalsGenerated: number;
    signalsExecuted: number;
    ordersPlaced: number;
    ordersFilled: number;
    ordersRejected: number;
    successRate: number;
  };
  
  // Financial metrics
  financial: {
    totalPnL: number;
    realizedPnL: number;
    unrealizedPnL: number;
    totalVolume: number;
    avgProfitPerTrade: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
  };
  
  // Risk metrics
  risk: {
    currentExposure: number;
    maxExposure: number;
    positionCount: number;
    riskScore: number;
    circuitBreakerActive: boolean;
    consecutiveLosses: number;
    errorRate: number;
  };
  
  // System health
  health: {
    cpuUsage: number;
    memoryUsage: number;
    wsConnected: boolean;
    apiLatency: number;
    uptime: number;
    errors: number;
  };
}

export class MetricsCollector extends EventEmitter {
  private registry: Registry;
  private logger: winston.Logger;
  private metrics: SystemMetrics;
  private startTime: number;
  
  // Prometheus metrics
  private counters: {
    signalsGenerated: Counter;
    signalsExecuted: Counter;
    ordersPlaced: Counter;
    ordersFilled: Counter;
    ordersRejected: Counter;
    errors: Counter;
  };
  
  private gauges: {
    currentPnL: Gauge;
    currentExposure: Gauge;
    positionCount: Gauge;
    riskScore: Gauge;
    cpuUsage: Gauge;
    memoryUsage: Gauge;
    wsConnectionStatus: Gauge;
  };
  
  private histograms: {
    signalLatency: Histogram;
    executionLatency: Histogram;
    riskCheckLatency: Histogram;
    profitPerTrade: Histogram;
  };
  
  constructor() {
    super();
    this.startTime = Date.now();
    this.registry = new Registry();
    this.setupPrometheusMetrics();
    this.initializeMetrics();
    this.setupLogger();
    
    // Collect default Node.js metrics
    collectDefaultMetrics({ register: this.registry });
    
    // Start periodic collection
    this.startPeriodicCollection();
  }
  
  private setupLogger(): void {
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ 
          filename: 'logs/metrics.log',
          maxsize: 10485760, // 10MB
          maxFiles: 5
        })
      ]
    });
  }
  
  private setupPrometheusMetrics(): void {
    // Counters
    this.counters = {
      signalsGenerated: new Counter({
        name: 'arb_signals_generated_total',
        help: 'Total number of signals generated',
        registers: [this.registry]
      }),
      signalsExecuted: new Counter({
        name: 'arb_signals_executed_total',
        help: 'Total number of signals executed',
        registers: [this.registry]
      }),
      ordersPlaced: new Counter({
        name: 'arb_orders_placed_total',
        help: 'Total number of orders placed',
        registers: [this.registry]
      }),
      ordersFilled: new Counter({
        name: 'arb_orders_filled_total',
        help: 'Total number of orders filled',
        registers: [this.registry]
      }),
      ordersRejected: new Counter({
        name: 'arb_orders_rejected_total',
        help: 'Total number of orders rejected',
        registers: [this.registry]
      }),
      errors: new Counter({
        name: 'arb_errors_total',
        help: 'Total number of errors',
        labelNames: ['type'],
        registers: [this.registry]
      })
    };
    
    // Gauges
    this.gauges = {
      currentPnL: new Gauge({
        name: 'arb_current_pnl_usd',
        help: 'Current total P&L in USD',
        registers: [this.registry]
      }),
      currentExposure: new Gauge({
        name: 'arb_current_exposure_usd',
        help: 'Current total exposure in USD',
        registers: [this.registry]
      }),
      positionCount: new Gauge({
        name: 'arb_position_count',
        help: 'Current number of open positions',
        registers: [this.registry]
      }),
      riskScore: new Gauge({
        name: 'arb_risk_score',
        help: 'Current risk score (0-1)',
        registers: [this.registry]
      }),
      cpuUsage: new Gauge({
        name: 'arb_cpu_usage_percent',
        help: 'CPU usage percentage',
        registers: [this.registry]
      }),
      memoryUsage: new Gauge({
        name: 'arb_memory_usage_mb',
        help: 'Memory usage in MB',
        registers: [this.registry]
      }),
      wsConnectionStatus: new Gauge({
        name: 'arb_ws_connection_status',
        help: 'WebSocket connection status (1=connected, 0=disconnected)',
        registers: [this.registry]
      })
    };
    
    // Histograms
    this.histograms = {
      signalLatency: new Histogram({
        name: 'arb_signal_latency_ms',
        help: 'Signal generation latency in ms',
        buckets: [10, 25, 50, 100, 250, 500, 1000],
        registers: [this.registry]
      }),
      executionLatency: new Histogram({
        name: 'arb_execution_latency_ms',
        help: 'Order execution latency in ms',
        buckets: [50, 100, 250, 500, 1000, 2500, 5000],
        registers: [this.registry]
      }),
      riskCheckLatency: new Histogram({
        name: 'arb_risk_check_latency_ms',
        help: 'Risk check latency in ms',
        buckets: [1, 5, 10, 25, 50, 100],
        registers: [this.registry]
      }),
      profitPerTrade: new Histogram({
        name: 'arb_profit_per_trade_usd',
        help: 'Profit per trade in USD',
        buckets: [-100, -50, -10, 0, 10, 50, 100, 500, 1000],
        registers: [this.registry]
      })
    };
  }
  
  private initializeMetrics(): void {
    this.metrics = {
      timestamp: Date.now(),
      latency: {
        signalGeneration: 0,
        signalTransformation: 0,
        orderExecution: 0,
        riskCheck: 0,
        total: 0
      },
      trading: {
        signalsGenerated: 0,
        signalsExecuted: 0,
        ordersPlaced: 0,
        ordersFilled: 0,
        ordersRejected: 0,
        successRate: 0
      },
      financial: {
        totalPnL: 0,
        realizedPnL: 0,
        unrealizedPnL: 0,
        totalVolume: 0,
        avgProfitPerTrade: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        winRate: 0
      },
      risk: {
        currentExposure: 0,
        maxExposure: 0,
        positionCount: 0,
        riskScore: 0,
        circuitBreakerActive: false,
        consecutiveLosses: 0,
        errorRate: 0
      },
      health: {
        cpuUsage: 0,
        memoryUsage: 0,
        wsConnected: false,
        apiLatency: 0,
        uptime: 0,
        errors: 0
      }
    };
  }
  
  private startPeriodicCollection(): void {
    // Collect system health metrics every 5 seconds
    setInterval(() => {
      this.collectSystemHealth();
    }, 5000);
    
    // Log aggregated metrics every minute
    setInterval(() => {
      this.logAggregatedMetrics();
    }, 60000);
    
    // Emit metrics for dashboard every second
    setInterval(() => {
      this.metrics.timestamp = Date.now();
      this.emit('metrics', this.metrics);
    }, 1000);
  }
  
  private collectSystemHealth(): void {
    const usage = process.cpuUsage();
    const memUsage = process.memoryUsage();
    
    this.metrics.health.cpuUsage = (usage.user + usage.system) / 1000000; // Convert to seconds
    this.metrics.health.memoryUsage = memUsage.heapUsed / 1024 / 1024; // Convert to MB
    this.metrics.health.uptime = (Date.now() - this.startTime) / 1000; // Convert to seconds
    
    // Update Prometheus gauges
    this.gauges.cpuUsage.set(this.metrics.health.cpuUsage);
    this.gauges.memoryUsage.set(this.metrics.health.memoryUsage);
  }
  
  private logAggregatedMetrics(): void {
    const summary = {
      timestamp: new Date().toISOString(),
      uptime: `${Math.floor(this.metrics.health.uptime / 60)}m`,
      trading: {
        signals: `${this.metrics.trading.signalsExecuted}/${this.metrics.trading.signalsGenerated}`,
        orders: `${this.metrics.trading.ordersFilled}/${this.metrics.trading.ordersPlaced}`,
        successRate: `${(this.metrics.trading.successRate * 100).toFixed(1)}%`
      },
      financial: {
        pnl: `$${this.metrics.financial.totalPnL.toFixed(2)}`,
        volume: `$${this.metrics.financial.totalVolume.toFixed(0)}`,
        sharpe: this.metrics.financial.sharpeRatio.toFixed(2),
        winRate: `${(this.metrics.financial.winRate * 100).toFixed(1)}%`
      },
      risk: {
        exposure: `$${this.metrics.risk.currentExposure.toFixed(0)}`,
        positions: this.metrics.risk.positionCount,
        riskScore: this.metrics.risk.riskScore.toFixed(2),
        circuitBreaker: this.metrics.risk.circuitBreakerActive ? 'ACTIVE' : 'OK'
      },
      health: {
        cpu: `${this.metrics.health.cpuUsage.toFixed(1)}%`,
        memory: `${this.metrics.health.memoryUsage.toFixed(0)}MB`,
        errors: this.metrics.health.errors
      }
    };
    
    this.logger.info('Metrics Summary', summary);
  }
  
  // Public update methods
  
  updateSignalMetrics(data: {
    generated?: number;
    executed?: number;
    latency?: number;
  }): void {
    if (data.generated) {
      this.metrics.trading.signalsGenerated += data.generated;
      this.counters.signalsGenerated.inc(data.generated);
    }
    if (data.executed) {
      this.metrics.trading.signalsExecuted += data.executed;
      this.counters.signalsExecuted.inc(data.executed);
    }
    if (data.latency) {
      this.metrics.latency.signalGeneration = data.latency;
      this.histograms.signalLatency.observe(data.latency);
    }
    
    this.updateSuccessRate();
  }
  
  updateOrderMetrics(data: {
    placed?: number;
    filled?: number;
    rejected?: number;
    latency?: number;
  }): void {
    if (data.placed) {
      this.metrics.trading.ordersPlaced += data.placed;
      this.counters.ordersPlaced.inc(data.placed);
    }
    if (data.filled) {
      this.metrics.trading.ordersFilled += data.filled;
      this.counters.ordersFilled.inc(data.filled);
    }
    if (data.rejected) {
      this.metrics.trading.ordersRejected += data.rejected;
      this.counters.ordersRejected.inc(data.rejected);
    }
    if (data.latency) {
      this.metrics.latency.orderExecution = data.latency;
      this.histograms.executionLatency.observe(data.latency);
    }
    
    this.updateSuccessRate();
  }
  
  updateFinancialMetrics(data: {
    pnl?: number;
    realizedPnl?: number;
    unrealizedPnl?: number;
    volume?: number;
    profit?: number;
    sharpe?: number;
    drawdown?: number;
    winRate?: number;
  }): void {
    if (data.pnl !== undefined) {
      this.metrics.financial.totalPnL = data.pnl;
      this.gauges.currentPnL.set(data.pnl);
    }
    if (data.realizedPnl !== undefined) {
      this.metrics.financial.realizedPnL = data.realizedPnl;
    }
    if (data.unrealizedPnl !== undefined) {
      this.metrics.financial.unrealizedPnL = data.unrealizedPnl;
    }
    if (data.volume !== undefined) {
      this.metrics.financial.totalVolume += data.volume;
    }
    if (data.profit !== undefined) {
      this.histograms.profitPerTrade.observe(data.profit);
      this.updateAvgProfit(data.profit);
    }
    if (data.sharpe !== undefined) {
      this.metrics.financial.sharpeRatio = data.sharpe;
    }
    if (data.drawdown !== undefined) {
      this.metrics.financial.maxDrawdown = Math.max(
        this.metrics.financial.maxDrawdown,
        data.drawdown
      );
    }
    if (data.winRate !== undefined) {
      this.metrics.financial.winRate = data.winRate;
    }
  }
  
  updateRiskMetrics(data: {
    exposure?: number;
    positions?: number;
    riskScore?: number;
    circuitBreaker?: boolean;
    consecutiveLosses?: number;
    errorRate?: number;
    checkLatency?: number;
  }): void {
    if (data.exposure !== undefined) {
      this.metrics.risk.currentExposure = data.exposure;
      this.metrics.risk.maxExposure = Math.max(
        this.metrics.risk.maxExposure,
        data.exposure
      );
      this.gauges.currentExposure.set(data.exposure);
    }
    if (data.positions !== undefined) {
      this.metrics.risk.positionCount = data.positions;
      this.gauges.positionCount.set(data.positions);
    }
    if (data.riskScore !== undefined) {
      this.metrics.risk.riskScore = data.riskScore;
      this.gauges.riskScore.set(data.riskScore);
    }
    if (data.circuitBreaker !== undefined) {
      this.metrics.risk.circuitBreakerActive = data.circuitBreaker;
    }
    if (data.consecutiveLosses !== undefined) {
      this.metrics.risk.consecutiveLosses = data.consecutiveLosses;
    }
    if (data.errorRate !== undefined) {
      this.metrics.risk.errorRate = data.errorRate;
    }
    if (data.checkLatency !== undefined) {
      this.metrics.latency.riskCheck = data.checkLatency;
      this.histograms.riskCheckLatency.observe(data.checkLatency);
    }
  }
  
  updateHealthMetrics(data: {
    wsConnected?: boolean;
    apiLatency?: number;
    error?: string;
  }): void {
    if (data.wsConnected !== undefined) {
      this.metrics.health.wsConnected = data.wsConnected;
      this.gauges.wsConnectionStatus.set(data.wsConnected ? 1 : 0);
    }
    if (data.apiLatency !== undefined) {
      this.metrics.health.apiLatency = data.apiLatency;
    }
    if (data.error) {
      this.metrics.health.errors++;
      this.counters.errors.inc({ type: data.error });
    }
  }
  
  private updateSuccessRate(): void {
    if (this.metrics.trading.signalsGenerated > 0) {
      this.metrics.trading.successRate = 
        this.metrics.trading.signalsExecuted / this.metrics.trading.signalsGenerated;
    }
  }
  
  private updateAvgProfit(profit: number): void {
    const trades = this.metrics.trading.ordersFilled;
    if (trades > 0) {
      this.metrics.financial.avgProfitPerTrade = 
        ((this.metrics.financial.avgProfitPerTrade * (trades - 1)) + profit) / trades;
    }
  }
  
  // Get methods
  
  getMetrics(): SystemMetrics {
    return { ...this.metrics };
  }
  
  getPrometheusMetrics(): Promise<string> {
    return this.registry.metrics();
  }
  
  reset(): void {
    this.registry.resetMetrics();
    this.initializeMetrics();
    this.logger.info('Metrics reset');
  }
}
