# 🚀 Hyperliquid Arbitrage Bot - Production Deployment Guide

## 📋 Table of Contents
- [System Architecture](#system-architecture)
- [Pre-Deployment Checklist](#pre-deployment-checklist)
- [Deployment Steps](#deployment-steps)
- [Monitoring & Operations](#monitoring--operations)
- [Risk Management](#risk-management)
- [Troubleshooting](#troubleshooting)
- [Emergency Procedures](#emergency-procedures)

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Hyperliquid Exchange                     │
└────────────────────────┬────────────────────────────────────┘
                         │ WebSocket + REST API
┌────────────────────────┴────────────────────────────────────┐
│                    HyperliquidClient                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │SignalGenerator│  │RiskManager   │  │PositionMonitor│     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │              │
│  ┌──────▼──────────────────▼──────────────────▼───────┐    │
│  │                  SignalBridge                       │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         │                                    │
│  ┌──────────────────────▼──────────────────────────────┐    │
│  │             SignalExecutor → ExecutionManager        │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│              Monitoring & Observability Stack                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │Dashboard  │  │Prometheus│  │ Grafana  │  │  Redis   │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## ✅ Pre-Deployment Checklist

### 1. **Environment Configuration**
- [ ] `.env` file configured with production values
- [ ] `.env.execution` file with execution parameters
- [ ] API keys and private keys securely stored
- [ ] Risk limits reviewed and approved

### 2. **Infrastructure Requirements**
- [ ] Docker & Docker Compose installed
- [ ] Minimum 4GB RAM, 2 CPU cores
- [ ] 20GB available disk space
- [ ] Stable internet connection (<50ms to Hyperliquid)

### 3. **Security Checklist**
- [ ] Private keys encrypted at rest
- [ ] Firewall rules configured
- [ ] SSH access secured
- [ ] Monitoring alerts configured
- [ ] Backup strategy in place

### 4. **Capital & Risk**
- [ ] Trading capital transferred to wallet
- [ ] Risk limits match available capital
- [ ] Stop-loss parameters verified
- [ ] Emergency contact list prepared

---

## 🚀 Deployment Steps

### 1. **Initial Setup**

```bash
# Clone repository (if not already)
git clone https://github.com/your-org/hyperliquid-arb-bot.git
cd hyperliquid-arb-bot

# Create environment files
cp .env.example .env
cp .env.execution.example .env.execution

# Edit configuration
nano .env
# Set:
# - HYPERLIQUID_PRIVATE_KEY
# - HYPERLIQUID_ACCOUNT_ADDRESS
# - BOT_MODE=production
# - Risk parameters

nano .env.execution
# Review and adjust execution parameters
```

### 2. **Test Deployment (Dry Run)**

```bash
# Start in dry-run mode first
BOT_MODE=dry-run docker-compose up

# Verify all components start correctly
# Check dashboard at http://localhost:4000
# Monitor logs for any errors

# Stop after verification
docker-compose down
```

### 3. **Testnet Deployment**

```bash
# Deploy to testnet
./scripts/deploy.sh --env testnet --action deploy

# Run for at least 24 hours
# Monitor performance metrics
# Verify risk controls work
```

### 4. **Production Deployment**

```bash
# FINAL PRODUCTION DEPLOYMENT
./scripts/deploy.sh --env production --action deploy

# Will prompt for confirmation
# Type 'CONFIRM' to proceed
```

---

## 📊 Monitoring & Operations

### **Dashboard Access**

| Service | URL | Purpose |
|---------|-----|---------|
| Bot Dashboard | http://localhost:4000 | Real-time bot metrics |
| Grafana | http://localhost:3000 | Historical analysis |
| Prometheus | http://localhost:9090 | Metrics database |

### **Key Metrics to Monitor**

1. **Financial Performance**
   - Total P&L (target: positive)
   - Win Rate (target: >50%)
   - Sharpe Ratio (target: >1.5)
   - Max Drawdown (alert: >10%)

2. **Operational Health**
   - WebSocket connection status
   - API latency (<100ms)
   - Error rate (<5%)
   - CPU/Memory usage

3. **Risk Indicators**
   - Risk score (alert: >0.7)
   - Current exposure vs limits
   - Consecutive losses (alert: >3)
   - Circuit breaker status

### **Daily Operations**

```bash
# Check status
./scripts/deploy.sh --action status

# View logs
docker-compose logs -f bot

# Restart if needed
./scripts/deploy.sh --action restart

# Export metrics
curl http://localhost:4000/api/metrics > metrics_$(date +%Y%m%d).json
```

---

## 🛡️ Risk Management

### **Risk Limits (Default)**

| Parameter | Testnet | Production | Description |
|-----------|---------|------------|-------------|
| Max Position Size | $1,000 | $500 | Per position limit |
| Max Total Exposure | $5,000 | $2,500 | Total capital at risk |
| Max Daily Loss | $100 | $50 | Daily stop loss |
| Stop Loss | 5% | 3% | Per position stop |
| Max Drawdown | 15% | 10% | Account drawdown limit |

### **Circuit Breaker Triggers**
- 3 consecutive losses
- 20% error rate
- Daily loss limit hit
- Risk score > 0.8

### **Manual Override**
```bash
# Reset circuit breaker (requires RISK_OVERRIDE_KEY)
curl -X POST http://localhost:4000/api/risk/reset \
  -H "Authorization: Bearer YOUR_RISK_OVERRIDE_KEY"
```

---

## 🔧 Troubleshooting

### **Common Issues**

| Issue | Solution |
|-------|----------|
| WebSocket disconnected | Check internet, restart bot |
| High latency | Check network, reduce position size |
| Circuit breaker active | Review recent trades, wait cooldown |
| Memory usage high | Restart bot, check for memory leaks |

### **Debug Commands**

```bash
# Check container health
docker-compose ps
docker stats

# View detailed logs
docker-compose logs --tail=100 bot

# Access container shell
docker exec -it hyperliquid-arb-bot sh

# Test connectivity
curl http://localhost:4000/api/health
```

---

## 🚨 Emergency Procedures

### **1. Emergency Stop**

```bash
# Immediate shutdown
docker-compose down

# Or use emergency stop endpoint
curl -X POST http://localhost:4000/api/emergency/stop
```

### **2. Close All Positions**

```bash
# Manual position closure
curl -X POST http://localhost:4000/api/positions/close-all \
  -H "Authorization: Bearer YOUR_ADMIN_KEY"
```

### **3. Disaster Recovery**

1. **Stop the bot immediately**
2. **Assess the situation**
   - Check positions on exchange
   - Calculate actual P&L
   - Review error logs
3. **Document the incident**
4. **Fix the issue**
5. **Test thoroughly before restart**

### **4. Contact Support**

- Technical Issues: [Create GitHub Issue]
- Exchange Issues: [Hyperliquid Support]
- Emergency: [Your emergency contact]

---

## 📈 Performance Optimization

### **Latency Optimization**
- Deploy close to exchange servers
- Use dedicated server (not shared hosting)
- Optimize network routes
- Consider co-location if available

### **Resource Tuning**
```yaml
# docker-compose.yml adjustments
deploy:
  resources:
    limits:
      cpus: '4'      # Increase for production
      memory: 4G     # Increase for production
```

### **Configuration Tuning**
```env
# Performance settings
UPDATE_INTERVAL_MS=500      # Faster updates
MAX_CONCURRENT_EXECUTIONS=5 # More parallel executions
MIN_PROFIT_TARGET_USD=5     # Lower threshold for HFT
```

---

## 📝 Maintenance Schedule

| Task | Frequency | Command/Action |
|------|-----------|----------------|
| Check metrics | Daily | Review dashboard |
| Export logs | Daily | `docker-compose logs > logs_$(date).txt` |
| Backup config | Weekly | Backup .env files |
| Update dependencies | Monthly | `npm update` (test first) |
| Review risk limits | Monthly | Adjust based on performance |
| Full system test | Quarterly | Run on testnet |

---

## 🎯 Success Criteria

Your bot is performing well if:
- ✅ Positive daily P&L trend
- ✅ Win rate > 50%
- ✅ Sharpe ratio > 1.5
- ✅ Max drawdown < 10%
- ✅ Error rate < 5%
- ✅ Uptime > 99%

---

## ⚠️ Disclaimer

**IMPORTANT**: Trading cryptocurrencies involves significant risk. This bot can lose money. Never trade with funds you cannot afford to lose. Past performance does not guarantee future results. Always monitor your bot and be prepared to intervene manually.

---

## 📚 Additional Resources

- [Hyperliquid Documentation](https://hyperliquid.gitbook.io)
- [Bot Wiki](./docs/wiki.md)
- [API Reference](./docs/api.md)
- [Risk Management Guide](./docs/risk.md)

---

*Last Updated: 2024*
*Version: 2.0.0*
