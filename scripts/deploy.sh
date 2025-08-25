#!/bin/bash

# Hyperliquid Arbitrage Bot Deployment Script
# Handles deployment to production/testnet environments

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="testnet"
ACTION="deploy"
FORCE_BUILD=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --env)
      ENVIRONMENT="$2"
      shift 2
      ;;
    --action)
      ACTION="$2"
      shift 2
      ;;
    --force-build)
      FORCE_BUILD=true
      shift
      ;;
    --help)
      echo "Usage: ./deploy.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --env [production|testnet|dry-run]  Deployment environment (default: testnet)"
      echo "  --action [deploy|stop|restart|status]  Action to perform (default: deploy)"
      echo "  --force-build                      Force Docker image rebuild"
      echo "  --help                             Show this help message"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}   Hyperliquid Arbitrage Bot Deployer${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}Environment:${NC} $ENVIRONMENT"
echo -e "${YELLOW}Action:${NC} $ACTION"
echo ""

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(production|testnet|dry-run)$ ]]; then
  echo -e "${RED}Invalid environment: $ENVIRONMENT${NC}"
  exit 1
fi

# Check for required files
check_requirements() {
  local missing=false
  
  if [ ! -f ".env" ]; then
    echo -e "${RED}Missing .env file${NC}"
    missing=true
  fi
  
  if [ ! -f ".env.execution" ]; then
    echo -e "${RED}Missing .env.execution file${NC}"
    missing=true
  fi
  
  if [ ! -f "docker-compose.yml" ]; then
    echo -e "${RED}Missing docker-compose.yml file${NC}"
    missing=true
  fi
  
  if [ "$missing" = true ]; then
    echo -e "${RED}Please ensure all required files exist${NC}"
    exit 1
  fi
}

# Deploy function
deploy() {
  echo -e "${YELLOW}Starting deployment...${NC}"
  
  # Set environment variable
  export BOT_MODE=$ENVIRONMENT
  
  # Build if needed
  if [ "$FORCE_BUILD" = true ] || [ ! "$(docker images -q hyperliquid-arb-bot 2> /dev/null)" ]; then
    echo -e "${YELLOW}Building Docker image...${NC}"
    docker-compose build --no-cache bot
  fi
  
  # Production warning
  if [ "$ENVIRONMENT" = "production" ]; then
    echo -e "${RED}⚠️  WARNING: Deploying to PRODUCTION${NC}"
    echo -e "${RED}⚠️  Real money will be at risk!${NC}"
    echo ""
    read -p "Type 'CONFIRM' to proceed: " confirm
    if [ "$confirm" != "CONFIRM" ]; then
      echo -e "${YELLOW}Deployment cancelled${NC}"
      exit 0
    fi
  fi
  
  # Start services
  echo -e "${YELLOW}Starting services...${NC}"
  docker-compose up -d
  
  # Wait for health check
  echo -e "${YELLOW}Waiting for services to be healthy...${NC}"
  sleep 10
  
  # Check status
  docker-compose ps
  
  echo ""
  echo -e "${GREEN}✅ Deployment complete!${NC}"
  echo ""
  echo -e "${GREEN}Dashboard:${NC} http://localhost:4000"
  echo -e "${GREEN}Grafana:${NC} http://localhost:3000 (admin/admin)"
  echo -e "${GREEN}Prometheus:${NC} http://localhost:9090"
  echo ""
  echo -e "${YELLOW}View logs:${NC} docker-compose logs -f bot"
  echo -e "${YELLOW}Stop services:${NC} ./deploy.sh --action stop"
}

# Stop function
stop() {
  echo -e "${YELLOW}Stopping services...${NC}"
  docker-compose down
  echo -e "${GREEN}✅ Services stopped${NC}"
}

# Restart function
restart() {
  echo -e "${YELLOW}Restarting services...${NC}"
  docker-compose restart
  echo -e "${GREEN}✅ Services restarted${NC}"
}

# Status function
status() {
  echo -e "${YELLOW}Service status:${NC}"
  docker-compose ps
  echo ""
  echo -e "${YELLOW}Resource usage:${NC}"
  docker stats --no-stream
}

# Main execution
check_requirements

case $ACTION in
  deploy)
    deploy
    ;;
  stop)
    stop
    ;;
  restart)
    restart
    ;;
  status)
    status
    ;;
  *)
    echo -e "${RED}Invalid action: $ACTION${NC}"
    exit 1
    ;;
esac
