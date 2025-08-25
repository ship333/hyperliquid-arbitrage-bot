import express, { Request, Response } from "express";
import { z } from "zod";
import { ENV } from "../../config/env";
import { evaluateArb } from "../../eval/model";
import { ArbInputs, FeesConfig, MarketFrictions, LatencyExec, SlippageModel, FailureTree } from "../../eval/types";
import { simulatePayouts, varCvar } from "../../eval/montecarlo";
import { rateLimit } from "../middleware/rateLimit";

const router = express.Router();

// Schemas (lenient to preserve backward compatibility)
const FeesSchema = z.object({
  totalFeesBps: z.number(),
  flashFeeBps: z.number().optional(),
  referralBps: z.number().optional(),
  executorFeeUsd: z.number().optional(),
  flashFixedUsd: z.number().optional(),
});

const FrictionsSchema = z.object({
  gasUsdMean: z.number(),
  gasUsdStd: z.number().optional(),
  adverseUsdMean: z.number(),
  adverseUsdStd: z.number().optional(),
  extraUsd: z.number().optional(),
  mevPenaltyUsd: z.number().optional(),
});

const LatencySchema = z.object({
  latencySec: z.number(),
  edgeDecayBpsPerSec: z.number().optional(),
  baseFillProb: z.number().optional(),
  partialFillShape: z.enum(["linear","concave","convex"]).optional(),
  theta: z.number().optional(),
});

const SlippageSchema = z.object({
  kind: z.enum(["amm_v2","univ3","empirical"]).default("empirical"),
  k: z.number().optional(),
  alpha: z.number().optional(),
  liquidityRefUsd: z.number().optional(),
});

const FailureSchema = z.object({
  failBeforeFillProb: z.number().default(0.02),
  failBetweenLegsProb: z.number().default(0.01),
  reorgOrMevProb: z.number().default(0.0),
});

const ArbInputSchema = z.object({
  edgeBps: z.number(),
  notionalUsd: z.number(),
  fees: FeesSchema,
  frictions: FrictionsSchema,
  latency: LatencySchema,
  slippage: SlippageSchema,
  failures: FailureSchema,
  flashEnabled: z.boolean().default(true),
  riskAversion: z.number().optional(),
  capitalUsd: z.number().optional(),
});

const BatchSchema = z.object({
  // either provide full inputs per item, or legacy arrays with params
  items: z.array(z.any()),
  // global overrides (optional)
  defaults: z.object({
    flashFeeBps: z.number().optional(),
    referralBps: z.number().optional(),
    executorFeeUsd: z.number().optional(),
    flashFixedUsd: z.number().optional(),
    edgeDecayBpsPerSec: z.number().optional(),
    baseFillProb: z.number().optional(),
    theta: z.number().optional(),
    slipAlpha: z.number().optional(),
    slipK: z.number().optional(),
    gasUsdStd: z.number().optional(),
    adverseUsdStd: z.number().optional(),
    mevPenaltyUsd: z.number().optional(),
    riskAversion: z.number().optional(),
    varCvar: z.boolean().optional(),
    mcSamples: z.number().optional(),
  }).partial().optional(),
});

function withEnvFees(fees: Partial<FeesConfig>): FeesConfig {
  return {
    totalFeesBps: fees.totalFeesBps ?? 0,
    flashFeeBps: fees.flashFeeBps ?? ENV.FLASH_FEE_BPS,
    referralBps: fees.referralBps ?? ENV.REFERRAL_BPS,
    executorFeeUsd: fees.executorFeeUsd ?? ENV.EXECUTOR_FEE_USD,
    flashFixedUsd: fees.flashFixedUsd ?? ENV.FLASH_FIXED_USD,
  };
}

function mapAnyToInputs(x: any, defaults: any): ArbInputs {
  // If already conforms, use it
  const maybe = ArbInputSchema.safeParse(x);
  if (maybe.success) return maybe.data as ArbInputs;

  // Legacy/loose mapping
  const fees: FeesConfig = withEnvFees({
    totalFeesBps: Number(x.totalFeesBps ?? x.fees_bps ?? 0),
    flashFeeBps: defaults.flashFeeBps,
    referralBps: defaults.referralBps,
    executorFeeUsd: defaults.executorFeeUsd,
    flashFixedUsd: defaults.flashFixedUsd,
  });
  const frictions: MarketFrictions = {
    gasUsdMean: Number(x.gas_usd ?? x.gasUsdMean ?? 0),
    gasUsdStd: defaults.gasUsdStd ?? ENV.GAS_USD_STD,
    adverseUsdMean: Number(x.adverse_usd ?? x.adverseUsdMean ?? 0),
    adverseUsdStd: defaults.adverseUsdStd ?? ENV.ADVERSE_USD_STD,
    extraUsd: Number(x.extra_usd ?? 0),
    mevPenaltyUsd: defaults.mevPenaltyUsd ?? ENV.MEV_PENALTY_USD,
  };
  const latency: LatencyExec = {
    latencySec: Number(x.seconds ?? x.latencySec ?? 1),
    edgeDecayBpsPerSec: defaults.edgeDecayBpsPerSec ?? ENV.EDGE_DECAY_BPS_PER_SEC,
    baseFillProb: defaults.baseFillProb ?? ENV.BASE_FILL_PROB,
    theta: defaults.theta ?? ENV.FILL_THETA,
  };
  const slippage: SlippageModel = {
    kind: "empirical",
    k: defaults.slipK ?? ENV.SLIP_K,
    alpha: defaults.slipAlpha ?? ENV.SLIP_ALPHA,
    liquidityRefUsd: Number(x.liquidity_ref_usd ?? x.liquidityRefUsd ?? 1_000_000),
  };
  const failures: FailureTree = {
    failBeforeFillProb: Number(x.fail_before_prob ?? 0.02),
    failBetweenLegsProb: Number(x.fail_between_prob ?? 0.01),
    reorgOrMevProb: Number(x.reorg_mev_prob ?? 0.0),
  };
  const flashEnabled = x.flashEnabled !== undefined ? Boolean(x.flashEnabled) : true;
  const riskAversion = defaults.riskAversion ?? ENV.RISK_AVERSION_LAMBDA;

  const inputs: ArbInputs = {
    edgeBps: Number(x.edge_bps ?? x.edgeBps ?? 0),
    notionalUsd: Number(x.notional_usd ?? x.notionalUsd ?? 0),
    fees, frictions, latency, slippage, failures, flashEnabled,
    riskAversion,
    capitalUsd: Number(x.capital_usd ?? x.capitalUsd ?? 0) || undefined,
  };
  return inputs;
}

router.post("/batch", rateLimit({ capacity: 10, refillPerMs: 500 }), (req: Request, res: Response) => {
  try {
    const parsed = BatchSchema.parse({ items: req.body?.items ?? [], defaults: req.body?.defaults ?? {} });
    const defaults = parsed.defaults || {};
    const inputs: ArbInputs[] = parsed.items.map((x: any) => mapAnyToInputs(x, defaults));
    const out = inputs.map((inp) => {
      const base = evaluateArb(inp);
      if (defaults.varCvar) {
        const samples = Math.max(100, Number(defaults.mcSamples ?? 1500));
        const draws = simulatePayouts(inp, samples);
        const { var: VaR, cvar: CVaR } = varCvar(draws, 0.95);
        return { ...base, var95: VaR, cvar95: CVaR };
      }
      return base;
    });
    res.json({ items: out });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

export default router;
