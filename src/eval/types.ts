// Strong types and explicit units for evaluation

export type FeesConfig = {
  totalFeesBps: number;              // router + LP total, bps
  flashFeeBps: number;               // ENV: FLASH_FEE_BPS
  referralBps: number;               // ENV: REFERRAL_BPS
  executorFeeUsd: number;            // ENV: EXECUTOR_FEE_USD
  flashFixedUsd: number;             // ENV: FLASH_FIXED_USD
};

export type MarketFrictions = {
  gasUsdMean: number;
  gasUsdStd?: number;                // stddev for stochastic gas (USD)
  adverseUsdMean: number;            // expected adverse selection cost (USD)
  adverseUsdStd?: number;            // stddev (USD)
  extraUsd?: number;                 // any other fixed overheads per attempt (USD)
  mevPenaltyUsd?: number;            // penalize reorg/MEV failures (USD)
};

export type LatencyExec = {
  latencySec: number;                // time from signal -> submit -> mined
  edgeDecayBpsPerSec: number;        // how fast edge decays with latency
  baseFillProb: number;              // baseline prob of getting both legs (no latency)
  partialFillShape?: "linear" | "concave" | "convex";
  theta?: number;                    // decay parameter for fill prob; default via env
};

export type SlippageModel = {
  kind: "amm_v2" | "univ3" | "empirical";
  k?: number;                        // invariant proxy or empirical slope
  alpha?: number;                    // curvature exponent (>1 convex)
  liquidityRefUsd?: number;          // reference depth for scaling
  // UniV3 optional parameters (if present, attempt exact-ish sim)
  sqrtPriceX96?: string;             // current sqrtPrice in Q96 (as decimal string)
  liquidity?: string;                // current in-range liquidity (as decimal string)
  feeTierBps?: number;               // 5, 30, 100
  tickSpacing?: number;              // pool tick spacing
  // Optional minimal tick map for offline sim (coarse)
  ticks?: Array<{ index: number; liquidityNet: string; sqrtPriceX96?: string }>; // subset of initialized ticks
  // Optional USD conversion hints for mapping sizeUsd to token amounts
  usdPerTokenIn?: number;            // price of input token in USD
  zeroForOne?: boolean;              // swap direction: token0 -> token1 when true
};

export type FailureTree = {
  failBeforeFillProb: number;        // tx fails/replaced, bundle not landed
  failBetweenLegsProb: number;       // first swap fills, second not
  reorgOrMevProb: number;            // reorgs/sandwich, etc.
};

export type ArbInputs = {
  edgeBps: number;                   // instantaneous bps edge at signal time
  notionalUsd: number;               // proposed size (USD)
  fees: FeesConfig;
  frictions: MarketFrictions;
  latency: LatencyExec;
  slippage: SlippageModel;
  failures: FailureTree;
  flashEnabled: boolean;
  riskAversion?: number;             // lambda for mean-variance penalty
  capitalUsd?: number;               // optional capital for utilization metrics
  secondsPerBlock?: number;          // for convenience if needed by callers
};

export type ArbResult = {
  net_usd_est: number;               // EV in USD
  ev_per_sec: number;                // EV divided by expected seconds
  size_opt_usd: number;              // argmax of EV_adj subject to constraints
  p_success: number;                 // prob of both legs success
  slip_bps_eff: number;              // effective slippage bps used
  breakeven_bps: number;             // all-in break-even bps at size_opt
  var95?: number;                    // optional VaR at 95%
  cvar95?: number;                   // optional CVaR at 95%
  score: number;                     // rank metric (e.g., EV_adj/sec)
  // legacy/breakdown
  gas_usd: number;
  seconds: number;
  flash_fee_bps: number;
  referral_bps: number;
  flash_fixed_usd: number;
  executor_fee_usd: number;
  flash_cost_usd: number;
  components?: Record<string, number>; // optional diagnostics
};
