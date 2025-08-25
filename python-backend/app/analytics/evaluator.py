from typing import List, Dict, Any
import pandas as pd
from .arb_formula import GasModel, LatencyModel, expected_net_usd, score_hft
from .size_opt import solve_best_dx

def evaluate_batch(opps: List[Dict[str,Any]], params: Dict[str,Any]) -> pd.DataFrame:
    rows = []
    for opp in opps:
        pair  = opp.get("pair","?")
        route = opp.get("route","?")
        Rin   = float(opp.get("rin") or 0.0)
        Rout  = float(opp.get("rout") or 0.0)
        fee_bps = float(opp.get("fee_bps", 0.0))
        px_out_usd = float(opp.get("px_out_usd", opp.get("native_usd",1.0)))
        edge_bps = float(opp.get("edge_bps", 0.0))
        gas = GasModel(
            base_fee_gwei=float(params.get("base_fee_gwei",0.5)),
            tip_gwei=float(params.get("priority_tip_gwei",0.5)),
            native_usd=float(opp.get("native_usd",1.0)),
            gas_limit=int(opp.get("gas_limit", opp.get("est_gas_limit",200000))),
            max_gas_usd_per_trade=float(params.get("max_gas_usd_per_trade",100.0))
        )
        lat = LatencyModel(
            decision_to_submit_ms=float(params.get("decision_to_submit_ms",200)),
            submit_to_inclusion_blocks=int(params.get("submit_to_inclusion_blocks",1)),
            seconds_per_block=float(params.get("seconds_per_block",1.0)),
            k_vol=float(params.get("k_vol",0.0)),
            notional_beta=float(params.get("notional_beta",1.0))
        )
        slip_cap_bps = float(params.get("slip_cap_bps",50.0))
        notional_cap = float(params.get("max_trade_usd",5e4))
        total_fees_bps = float(params.get("total_fees_bps", opp.get("lp_fees_bps",0.0) + opp.get("router_fees_bps",0.0)))
        fail_prob = float(params.get("fail_prob",0.0))

        # --- HyperLend flash-loan costs (all in USD space) ---
        # Modeled as extra_usd costs added to expected_net_usd
        flash_fee_bps = float(params.get("flash_fee_bps", 0.0))         # fee proportional to notional
        referral_bps  = float(params.get("referral_bps", 0.0))          # optional referral on notional
        flash_fixed_usd = float(params.get("flash_fixed_usd", 0.0))     # fixed overhead per flash
        executor_fee_usd = float(params.get("executor_fee_usd", 0.0))   # onchain executor service fee

        def flash_cost_usd(notional_usd: float) -> float:
            var_fee = (flash_fee_bps + referral_bps) / 10000.0 * notional_usd
            return float(var_fee + flash_fixed_usd + executor_fee_usd)

        def net_fn(notional_usd: float)->float:
            adv = lat.adverse_usd(notional_usd)
            extra = float(params.get("extra_usd",0.0)) + flash_cost_usd(notional_usd)
            return expected_net_usd(edge_bps, notional_usd, total_fees_bps, gas.usd(), adv, extra_usd=extra, fail_prob=fail_prob)
        if Rin>0 and Rout>0:
            best_dx, best_net, best_slip = solve_best_dx(Rin,Rout,fee_bps,px_out_usd,notional_cap,slip_cap_bps,net_fn)
        else:
            best_dx, best_net, best_slip = 0.0, net_fn(notional_cap), 0.0
        seconds = max(lat.inclusion_seconds(), 1e-3)
        s = score_hft(best_net, gas.usd(), seconds,
                      float(params.get("w_net",1.0)),
                      float(params.get("w_ppg",0.6)),
                      float(params.get("w_pps",0.6)))
        # Expose key components for observability
        # For the selected best_dx, approximate flash costs using notional ~ best_dx * px_out_usd (bounded by notional_cap)
        approx_notional_usd = min(notional_cap, max(0.0, float(best_dx) * float(px_out_usd))) if Rin>0 and Rout>0 else notional_cap
        rows.append({
            "pair":pair, "route":route,
            "net_usd":round(best_net,6),
            "gas_usd":round(gas.usd(),6),
            "seconds":round(seconds,4),
            "slip_bps":round(best_slip,4),
            "score":round(s,6),
            "flash_fee_bps":flash_fee_bps,
            "referral_bps":referral_bps,
            "flash_fixed_usd":flash_fixed_usd,
            "executor_fee_usd":executor_fee_usd,
            "flash_cost_usd":round(flash_cost_usd(approx_notional_usd),6)
        })
    df = pd.DataFrame(rows).sort_values("score", ascending=False).reset_index(drop=True)
    return df

def greedy_knapsack_by_score(df: pd.DataFrame, gas_budget_usd: float) -> pd.DataFrame:
    sel = []
    total_gas = 0.0
    for _,r in df.iterrows():
        if total_gas + r["gas_usd"] <= gas_budget_usd:
            sel.append(r)
            total_gas += r["gas_usd"]
    return pd.DataFrame(sel)
