Param(
  [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

# Resolve paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$BackendPath = Join-Path $ProjectRoot 'python-backend'
$WebPath = Join-Path $ProjectRoot 'web'
$VenvPath = Join-Path $ProjectRoot '.venv'
$PythonExe = Join-Path $VenvPath 'Scripts\python.exe'

Write-Host "Project root: $ProjectRoot"

# 1) Ensure venv
if (!(Test-Path $VenvPath)) {
  Write-Host 'Creating virtual environment (.venv)...'
  python -m venv $VenvPath
}
if (!(Test-Path $PythonExe)) {
  throw "Python executable not found in venv: $PythonExe"
}

# 2) Install dependencies (unless skipped)
if (-not $NoInstall) {
  Write-Host 'Upgrading pip...'
  & $PythonExe -m pip install --upgrade pip
  Write-Host 'Installing backend requirements...'
  & $PythonExe -m pip install -r (Join-Path $BackendPath 'requirements.txt')
}

# 3) Set environment variables (session-only)
$env:ALCHEMY_RPC_URL = 'https://hyperliquid-mainnet.g.alchemy.com/v2/alcht_ejTTQ7WxJAnNw8yYbNSjRvlJyQ9gul'

# --- Goldsky GraphQL configuration ---
$env:GOLDSKY_MODE = 'graphql'
# Fill with your actual GN endpoint (public or private)
# Public example:
# $env:GOLDSKY_GQL_URL = 'https://api.goldsky.com/api/public/{project_id}/subgraphs/{subgraph_name}/{tag}/gn'
# Private example:
# Default to the public subgraph URL used in config/sample.env for quick start.
# Replace with your private GN URL if needed.
$env:GOLDSKY_GQL_URL = 'https://api.goldsky.com/api/public/project_cmbbm2iwckb1b01t39xed236t/subgraphs/uniswap-v3-hyperevm-position/prod/gn'

# Auth header scheme
# Private endpoints typically use Authorization: Bearer <token>
# For public endpoints, no header is required; key stays empty.
# For private endpoints, set Authorization: Bearer <token>.
$env:GOLDSKY_API_HEADER = 'Authorization'
$env:GOLDSKY_API_PREFIX = 'Bearer '
$env:GOLDSKY_API_KEY = ''  # public subgraph: leave empty; private: set token here or before running

# Optional overrides for schema differences
# Default to a Uniswap V3-style poolHourData query, which many subgraphs expose.
$env:GOLDSKY_GQL_QUERY = @'
query PoolHour($poolId: ID!, $limit: Int!) {
  pool(id: $poolId) {
    poolHourData(first: $limit, orderBy: periodStartUnix, orderDirection: desc) {
      periodStartUnix
      token0Price
      token1Price
      liquidity
      sqrtPrice
      tvlUSD
    }
  }
}
'@
$env:GOLDSKY_GQL_ITEMS_PATH = 'data.pool.poolHourData'

# Cache TTL for pool history endpoint (seconds)
$env:GOLDSKY_CACHE_TTL_SEC = '30'

Write-Host 'Environment variables set for this session:'
Write-Host "  ALCHEMY_RPC_URL=$($env:ALCHEMY_RPC_URL)"
Write-Host "  GOLDSKY_MODE=$($env:GOLDSKY_MODE)"
Write-Host "  GOLDSKY_GQL_URL=$($env:GOLDSKY_GQL_URL)"
Write-Host "  GOLDSKY_API_KEY=(hidden)"
Write-Host "  GOLDSKY_API_HEADER=$($env:GOLDSKY_API_HEADER)"
Write-Host "  GOLDSKY_API_PREFIX=$($env:GOLDSKY_API_PREFIX)"
Write-Host "  GOLDSKY_GQL_ITEMS_PATH=$($env:GOLDSKY_GQL_ITEMS_PATH)"
Write-Host "  GOLDSKY_CACHE_TTL_SEC=$($env:GOLDSKY_CACHE_TTL_SEC)"

# 4) Start backend (Uvicorn) in a new window
$UvicornArgs = @('-m','uvicorn','app.main:app','--host','0.0.0.0','--port','9011','--reload')
Write-Host 'Starting backend on http://127.0.0.1:9011 ...'
Start-Process -FilePath $PythonExe -ArgumentList $UvicornArgs -WorkingDirectory $BackendPath -WindowStyle Normal

# 5) Start frontend static server in a new window
$HttpArgs = @('-m','http.server','9010')
Write-Host 'Starting frontend server on http://127.0.0.1:9010 ...'
Start-Process -FilePath $PythonExe -ArgumentList $HttpArgs -WorkingDirectory $WebPath -WindowStyle Normal

Write-Host ''
Write-Host 'Done. Open the dashboard:'
Write-Host '  Frontend: http://127.0.0.1:9010'
Write-Host '  Backend  : http://127.0.0.1:9011'
Write-Host ''
Write-Host 'Notes:'
Write-Host ' - To skip reinstall on subsequent runs, use: -NoInstall'
Write-Host ' - Frontend: ensure Backend Base is http://127.0.0.1:9011 (clear localStorage backend_base if needed).'
Write-Host ' - Goldsky: using GraphQL mode; set GOLDSKY_GQL_URL and GOLDSKY_API_KEY as needed.'
