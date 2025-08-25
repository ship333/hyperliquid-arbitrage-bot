/**
 * Real-time Monitoring Dashboard
 * WebSocket-based dashboard for monitoring bot performance
 */

import express from 'express';
import http from 'http';
import WebSocket from 'ws';
import path from 'path';
import { MetricsCollector, SystemMetrics } from './MetricsCollector';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [new winston.transports.Console()]
});

interface DashboardConfig {
  port: number;
  updateInterval: number;
  metricsCollector?: MetricsCollector;
}

interface Alert {
  id: string;
  level: 'info' | 'warning' | 'critical';
  message: string;
  timestamp: number;
  acknowledged: boolean;
}

class MonitoringDashboard {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocket.Server;
  private metricsCollector: MetricsCollector;
  private clients: Set<WebSocket> = new Set();
  private alerts: Map<string, Alert> = new Map();
  private alertThresholds = {
    maxDrawdown: 0.15,
    minWinRate: 0.4,
    maxRiskScore: 0.8,
    maxConsecutiveLosses: 5,
    maxErrorRate: 0.2,
    minUptime: 300 // 5 minutes
  };

  constructor(private config: DashboardConfig) {
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server });
    this.metricsCollector = config.metricsCollector || new MetricsCollector();
    
    this.setupExpress();
    this.setupWebSocket();
    this.setupMetricsListener();
    this.startAlertMonitoring();
  }

  private setupExpress(): void {
    // Serve static files
    this.app.use(express.static(path.join(__dirname, 'public')));
    
    // API endpoints
    this.app.get('/api/metrics', async (req, res) => {
      const metrics = this.metricsCollector.getMetrics();
      res.json(metrics);
    });
    
    this.app.get('/api/prometheus', async (req, res) => {
      const metrics = await this.metricsCollector.getPrometheusMetrics();
      res.set('Content-Type', 'text/plain');
      res.send(metrics);
    });
    
    this.app.get('/api/alerts', (req, res) => {
      const alerts = Array.from(this.alerts.values())
        .sort((a, b) => b.timestamp - a.timestamp);
      res.json(alerts);
    });
    
    this.app.post('/api/alerts/:id/acknowledge', express.json(), (req, res) => {
      const alert = this.alerts.get(req.params.id);
      if (alert) {
        alert.acknowledged = true;
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Alert not found' });
      }
    });
    
    this.app.get('/api/health', (req, res) => {
      const metrics = this.metricsCollector.getMetrics();
      const health = {
        status: this.getHealthStatus(metrics),
        uptime: metrics.health.uptime,
        connections: this.clients.size,
        alerts: this.alerts.size,
        timestamp: Date.now()
      };
      res.json(health);
    });
    
    // Serve dashboard HTML
    this.app.get('/', (req, res) => {
      res.send(this.getDashboardHTML());
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      logger.info('New dashboard client connected');
      this.clients.add(ws);
      
      // Send initial metrics
      const metrics = this.metricsCollector.getMetrics();
      ws.send(JSON.stringify({
        type: 'metrics',
        data: metrics
      }));
      
      // Send current alerts
      ws.send(JSON.stringify({
        type: 'alerts',
        data: Array.from(this.alerts.values())
      }));
      
      ws.on('close', () => {
        logger.info('Dashboard client disconnected');
        this.clients.delete(ws);
      });
      
      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
        this.clients.delete(ws);
      });
    });
  }

  private setupMetricsListener(): void {
    this.metricsCollector.on('metrics', (metrics: SystemMetrics) => {
      this.broadcast({
        type: 'metrics',
        data: metrics
      });
      
      // Check for alert conditions
      this.checkAlertConditions(metrics);
    });
  }

  private startAlertMonitoring(): void {
    setInterval(() => {
      // Clean up old acknowledged alerts
      const cutoff = Date.now() - 3600000; // 1 hour
      for (const [id, alert] of this.alerts) {
        if (alert.acknowledged && alert.timestamp < cutoff) {
          this.alerts.delete(id);
        }
      }
    }, 60000); // Every minute
  }

  private checkAlertConditions(metrics: SystemMetrics): void {
    // Check drawdown
    if (metrics.financial.maxDrawdown > this.alertThresholds.maxDrawdown) {
      this.createAlert('critical', 
        `Max drawdown exceeded: ${(metrics.financial.maxDrawdown * 100).toFixed(1)}%`);
    }
    
    // Check win rate
    if (metrics.financial.winRate < this.alertThresholds.minWinRate && 
        metrics.trading.ordersFilled > 10) {
      this.createAlert('warning', 
        `Low win rate: ${(metrics.financial.winRate * 100).toFixed(1)}%`);
    }
    
    // Check risk score
    if (metrics.risk.riskScore > this.alertThresholds.maxRiskScore) {
      this.createAlert('critical', 
        `High risk score: ${metrics.risk.riskScore.toFixed(2)}`);
    }
    
    // Check consecutive losses
    if (metrics.risk.consecutiveLosses >= this.alertThresholds.maxConsecutiveLosses) {
      this.createAlert('critical', 
        `${metrics.risk.consecutiveLosses} consecutive losses`);
    }
    
    // Check error rate
    if (metrics.risk.errorRate > this.alertThresholds.maxErrorRate) {
      this.createAlert('warning', 
        `High error rate: ${(metrics.risk.errorRate * 100).toFixed(1)}%`);
    }
    
    // Check circuit breaker
    if (metrics.risk.circuitBreakerActive) {
      this.createAlert('critical', 'Circuit breaker is ACTIVE');
    }
    
    // Check WebSocket connection
    if (!metrics.health.wsConnected) {
      this.createAlert('critical', 'WebSocket disconnected');
    }
  }

  private createAlert(level: Alert['level'], message: string): void {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const alert: Alert = {
      id,
      level,
      message,
      timestamp: Date.now(),
      acknowledged: false
    };
    
    // Don't create duplicate alerts
    const existing = Array.from(this.alerts.values()).find(
      a => a.message === message && !a.acknowledged
    );
    if (existing) return;
    
    this.alerts.set(id, alert);
    
    // Broadcast to clients
    this.broadcast({
      type: 'alert',
      data: alert
    });
    
    // Log alert
    const logLevel = level === 'critical' ? 'error' : level === 'warning' ? 'warn' : 'info';
    logger[logLevel](`Alert [${level}]: ${message}`);
  }

  private broadcast(message: any): void {
    const data = JSON.stringify(message);
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  private getHealthStatus(metrics: SystemMetrics): 'healthy' | 'degraded' | 'critical' {
    if (metrics.risk.circuitBreakerActive || !metrics.health.wsConnected) {
      return 'critical';
    }
    if (metrics.risk.riskScore > 0.7 || metrics.risk.errorRate > 0.1) {
      return 'degraded';
    }
    return 'healthy';
  }

  private getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hyperliquid Arbitrage Bot Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0b0d;
            color: #e4e4e7;
            line-height: 1.6;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px 0;
            border-bottom: 1px solid #27272a;
            margin-bottom: 30px;
        }
        .title {
            font-size: 24px;
            font-weight: 600;
            color: #fbbf24;
        }
        .status {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .status-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            animation: pulse 2s infinite;
        }
        .status-healthy { background: #10b981; }
        .status-degraded { background: #f59e0b; }
        .status-critical { background: #ef4444; }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .metric-card {
            background: #18181b;
            border: 1px solid #27272a;
            border-radius: 8px;
            padding: 20px;
        }
        .metric-label {
            font-size: 12px;
            color: #71717a;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 5px;
        }
        .metric-value {
            font-size: 24px;
            font-weight: 600;
            color: #fff;
        }
        .metric-change {
            font-size: 14px;
            margin-top: 5px;
        }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        
        .charts-container {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .chart-card {
            background: #18181b;
            border: 1px solid #27272a;
            border-radius: 8px;
            padding: 20px;
            height: 300px;
        }
        .chart-title {
            font-size: 16px;
            margin-bottom: 15px;
            color: #e4e4e7;
        }
        
        .alerts-container {
            background: #18181b;
            border: 1px solid #27272a;
            border-radius: 8px;
            padding: 20px;
        }
        .alerts-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .alerts-title {
            font-size: 18px;
            color: #e4e4e7;
        }
        .alert-item {
            display: flex;
            align-items: center;
            padding: 12px;
            margin-bottom: 10px;
            border-radius: 6px;
            background: #27272a;
        }
        .alert-critical { border-left: 3px solid #ef4444; }
        .alert-warning { border-left: 3px solid #f59e0b; }
        .alert-info { border-left: 3px solid #3b82f6; }
        .alert-icon {
            margin-right: 12px;
            font-size: 20px;
        }
        .alert-message {
            flex: 1;
            font-size: 14px;
        }
        .alert-time {
            font-size: 12px;
            color: #71717a;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title">⚡ Hyperliquid Arbitrage Bot</div>
            <div class="status">
                <span class="status-indicator status-healthy" id="statusIndicator"></span>
                <span id="statusText">Connecting...</span>
            </div>
        </div>
        
        <div class="metrics-grid">
            <div class="metric-card">
                <div class="metric-label">Total P&L</div>
                <div class="metric-value" id="totalPnL">$0.00</div>
                <div class="metric-change positive" id="pnlChange">+0.0%</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Win Rate</div>
                <div class="metric-value" id="winRate">0.0%</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Sharpe Ratio</div>
                <div class="metric-value" id="sharpeRatio">0.00</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Current Exposure</div>
                <div class="metric-value" id="exposure">$0</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Positions</div>
                <div class="metric-value" id="positions">0</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Risk Score</div>
                <div class="metric-value" id="riskScore">0.00</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Signals Executed</div>
                <div class="metric-value" id="signals">0/0</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Success Rate</div>
                <div class="metric-value" id="successRate">0.0%</div>
            </div>
        </div>
        
        <div class="charts-container">
            <div class="chart-card">
                <div class="chart-title">P&L Over Time</div>
                <canvas id="pnlChart"></canvas>
            </div>
            <div class="chart-card">
                <div class="chart-title">Latency Distribution</div>
                <canvas id="latencyChart"></canvas>
            </div>
        </div>
        
        <div class="alerts-container">
            <div class="alerts-header">
                <div class="alerts-title">Recent Alerts</div>
                <span id="alertCount">0 active</span>
            </div>
            <div id="alertsList"></div>
        </div>
    </div>
    
    <script>
        const ws = new WebSocket('ws://' + window.location.host);
        
        ws.onopen = () => {
            updateStatus('healthy', 'Connected');
        };
        
        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            
            if (message.type === 'metrics') {
                updateMetrics(message.data);
            } else if (message.type === 'alert') {
                addAlert(message.data);
            } else if (message.type === 'alerts') {
                message.data.forEach(addAlert);
            }
        };
        
        ws.onclose = () => {
            updateStatus('critical', 'Disconnected');
        };
        
        function updateStatus(status, text) {
            const indicator = document.getElementById('statusIndicator');
            const statusText = document.getElementById('statusText');
            
            indicator.className = 'status-indicator status-' + status;
            statusText.textContent = text;
        }
        
        function updateMetrics(metrics) {
            // Update metric cards
            document.getElementById('totalPnL').textContent = 
                '$' + metrics.financial.totalPnL.toFixed(2);
            
            document.getElementById('winRate').textContent = 
                (metrics.financial.winRate * 100).toFixed(1) + '%';
            
            document.getElementById('sharpeRatio').textContent = 
                metrics.financial.sharpeRatio.toFixed(2);
            
            document.getElementById('exposure').textContent = 
                '$' + metrics.risk.currentExposure.toFixed(0);
            
            document.getElementById('positions').textContent = 
                metrics.risk.positionCount;
            
            document.getElementById('riskScore').textContent = 
                metrics.risk.riskScore.toFixed(2);
            
            document.getElementById('signals').textContent = 
                metrics.trading.signalsExecuted + '/' + metrics.trading.signalsGenerated;
            
            document.getElementById('successRate').textContent = 
                (metrics.trading.successRate * 100).toFixed(1) + '%';
            
            // Update status based on metrics
            if (metrics.risk.circuitBreakerActive) {
                updateStatus('critical', 'Circuit Breaker Active');
            } else if (!metrics.health.wsConnected) {
                updateStatus('critical', 'WebSocket Disconnected');
            } else if (metrics.risk.riskScore > 0.7) {
                updateStatus('degraded', 'High Risk');
            } else {
                updateStatus('healthy', 'Operational');
            }
        }
        
        function addAlert(alert) {
            const alertsList = document.getElementById('alertsList');
            const alertDiv = document.createElement('div');
            alertDiv.className = 'alert-item alert-' + alert.level;
            
            const icon = alert.level === 'critical' ? '🚨' : 
                         alert.level === 'warning' ? '⚠️' : 'ℹ️';
            
            const time = new Date(alert.timestamp).toLocaleTimeString();
            
            alertDiv.innerHTML = \`
                <span class="alert-icon">\${icon}</span>
                <span class="alert-message">\${alert.message}</span>
                <span class="alert-time">\${time}</span>
            \`;
            
            alertsList.insertBefore(alertDiv, alertsList.firstChild);
            
            // Keep only last 10 alerts
            while (alertsList.children.length > 10) {
                alertsList.removeChild(alertsList.lastChild);
            }
            
            // Update alert count
            const activeAlerts = alertsList.querySelectorAll('.alert-critical, .alert-warning').length;
            document.getElementById('alertCount').textContent = activeAlerts + ' active';
        }
    </script>
</body>
</html>`;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, () => {
        logger.info(`📊 Monitoring dashboard running at http://localhost:${this.config.port}`);
        logger.info(`📈 Prometheus metrics available at http://localhost:${this.config.port}/api/prometheus`);
        resolve();
      });
    });
  }

  stop(): void {
    this.server.close();
    this.wss.close();
    this.clients.clear();
    logger.info('Monitoring dashboard stopped');
  }
}

// Main execution
async function main() {
  const port = parseInt(process.env.DASHBOARD_PORT || '4000');
  
  const dashboard = new MonitoringDashboard({
    port,
    updateInterval: 1000
  });
  
  await dashboard.start();
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down dashboard...');
    dashboard.stop();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch(console.error);
}

export { MonitoringDashboard };
