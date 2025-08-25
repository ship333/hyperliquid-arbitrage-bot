# Hyperliquid Arbitrage Bot (MVP)

Monorepo for a cross-DEX arbitrage bot targeting PRJX and HyperSwap on Hyperliquid EVM.

## Structure

- `rust-engine/` — Latency-sensitive off-chain arbitrage engine (Rust)
- `python-backend/` — FastAPI service with endpoints for health, strategies, Goldsky integration, and trade executor (dry-run) located under `python-backend/app/`.
- `web/` — Lightweight dashboard (HTML/JS/CSS)
- `contracts/` — Core arbitrage smart contract (Solidity)
- `config/` — Environment examples and local settings

### HyperLend Flash-Loan Executor

- Contract: `contracts/ArbitrageExecutor.sol` (Solc ^0.8.24)
  - Receives a flash loan from `HYPERLEND_POOL` and performs two generic router swaps via opaque calldata.
  - Safety: `Ownable2Step`, `Pausable`, `ReentrancyGuard`, and `SafeERC20`-style helpers.
  - Callbacks supported (provider decides which is used):
    - `onFlashLoan(address initiator, address asset, uint256 amount, uint256 fee, bytes params)`
    - `executeOperation(address asset, uint256 amount, uint256 fee, address initiator, bytes params)`
  - Parameters format (ABI tuple) decoded in callback:
    - `(address buyRouter,address buySpender,bytes buyCalldata,address sellRouter,address sellSpender,bytes sellCalldata,address tokenBorrowed,address tokenIntermediate,address profitToken,uint256 minProfit)`
  - Emits `FlashArbExecuted(asset, amount, fee, profitToken, profit)` upon success.

- Example script: `scripts/flashloan.ts`
  - Encodes FlashParams and calls `initiateFlashArb(asset, amount, params, referralCode)` on the executor.
  - ENV: `RPC_URL`, `OWNER_PK`, `EXECUTOR`, `ASSET`, `AMOUNT`.
  - You must fill in router addresses and calldata externally.

> NOTE: Replace `IHyperLendPoolSimple`/`IHyperLendPoolMultiAsset` and callback return conventions with the official HyperLend ABI before production.

### Evaluator: Flash-Loan Costs

- File: `python-backend/app/analytics/evaluator.py`
  - Net calculation uses `expected_net_usd(...)` and now includes flash-loan costs via `extra_usd`.
  - New params (can be provided per-request or via ENV defaults):
    - `flash_fee_bps` (basis points on notional)
    - `referral_bps` (optional basis points on notional)
    - `flash_fixed_usd` (fixed overhead per flash)
    - `executor_fee_usd` (service cost per trade)
  - Output includes diagnostic fields: `flash_fee_bps`, `referral_bps`, `flash_fixed_usd`, `executor_fee_usd`, `flash_cost_usd`.

### ENV Defaults

Set in `.env` or your runtime environment. The backend will merge these into evaluator params if the request omits them:

```
FLASH_FEE_BPS=0
REFERRAL_BPS=0
FLASH_FIXED_USD=0
EXECUTOR_FEE_USD=0
```

HyperLend addresses (placeholders):

```
HYPERLEND_POOL=
ARB_EXECUTOR_ADDRESS=
```

### Workflow

1) Build router calldata off-chain for both legs (buy then sell).
2) Encode `FlashParams` and call `initiateFlashArb` on `ArbitrageExecutor`.
3) Use evaluator endpoints to estimate profitability including flash-loan costs:
   - `POST /api/eval/batch` with params including the flash-loan fields.
   - Or set ENV defaults listed above.

## Quickstart

1. Python backend

```powershell
# Windows PowerShell
python -m venv .venv
. .venv\Scripts\Activate.ps1
pip install -r python-backend\requirements.txt
uvicorn app.main:app --reload --app-dir python-backend --port 9011
```

2. Rust engine (compiles; logic is stubbed)

```bash
cargo run --manifest-path rust-engine/Cargo.toml
```

3. Open dashboard

- Backend runs on <http://127.0.0.1:9011> (FastAPI docs at `/docs`)
- Dashboard static files are in `web/` (open `web/index.html` or serve via `python -m http.server`)

## Environment

Copy `config/sample.env` to `.env` and fill values.

- `DEEPSEEK_API_KEY=...`
- `HYPEREVM_RPC=https://api.hyperliquid-testnet.xyz/evm`
- `PRJX_SUBGRAPH=https://api.goldsky.com/api/public/project_cmbbm2iwckb1b01t39xed236t/subgraphs/uniswap-v3-hyperevm-position/prod/gn`
- Goldsky pool history (choose one):
  - GraphQL mode (recommended):
    - `GOLDSKY_MODE=graphql`
    - `GOLDSKY_GQL_URL=https://api.goldsky.com/api/public/<project>/subgraphs/<name>/<tag>/gn`
    - `GOLDSKY_API_HEADER=Authorization` (default)
    - `GOLDSKY_API_PREFIX=Bearer` (append a space if needed by your provider)
    - `GOLDSKY_API_KEY=<token>` (if using private endpoint)
    - Optional overrides:
      - `GOLDSKY_GQL_QUERY=...` (custom GraphQL query)
      - `GOLDSKY_GQL_ITEMS_PATH=data.pool.reserves`
  - REST mode:
    - `GOLDSKY_MODE=rest`
    - `GOLDSKY_API_URL=https://...`
    - `GOLDSKY_POOL_RES_PATH=pools/{pool_id}/reserves`

- Caching:
  - `GOLDSKY_CACHE_TTL_SEC=30`

- Optional reference pool IDs (for UI/manual testing only):
  - `HYPE_USDC_POOL_ID=...`
  - `HYPE_uETH_POOL_ID=...`
  - `KHYPE_HYPE_POOL_ID=...`

## Next Steps

- Finalize Goldsky pool IDs for Hyperliquid EVM and verify snapshots via `/api/goldsky/pools/{pool_id}/history`.
- Wire Rust engine to PRJX GraphQL and HyperSwap SDK (ffi/bindings or RPC calls)
- Implement WebSocket streaming to backend
- Finalize Solidity router calls and test on testnet
- Add authentication and persistent storage (SQLite/Redis)

## Useful Endpoints

- Health and status
  - `GET /api/health` — shows service status, Goldsky mode/provider, and Goldsky cache freshness/errors.

- Goldsky
  - `GET /api/goldsky/pools/{pool_id}/history?limit=1000` — validated pool snapshots.

- Trade (executor skeleton)
  - `POST /api/trade/quote` — body: `{ "amount_in": 1000, "slippage_bps": 50 }`
  - `POST /api/trade/simulate` — body: `{ "amount_in": 1000, "slippage_bps": 50, "gas_price_wei": 20000000000, "gas_limit": 250000, "native_price_usd": 2000 }`
  - `POST /api/trade/execute` — body: `{ "dry_run": true }` (live execution not implemented)
  - `GET /api/trade/limits` — view safety limits
  - `POST /api/trade/limits` — set safety limits: `{ "max_amount_in": 100000, "max_gas_limit": 600000, "max_slippage_bps": 100 }`
