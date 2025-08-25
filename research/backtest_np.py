"""
Vectorized NumPy backtester that mirrors server cost logic for fast parameter sweeps.

Supports:
- Simple cost model: bps + gas
- HFT cost model: gas (base+tip)*gas_limit*price + latency penalty + failure prob + frictions
- Optional notional_cap_usd and slip/fee bps

Usage:
    from research.data_loader import fetch_recent, to_dataframe
    from research.backtest_np import vector_backtest
    rows = fetch_recent()
    df = to_dataframe(rows)
    metrics = vector_backtest(df, params={
        'min_spread_bps': 10,
        'min_liquidity_usd': 10000,
        'slippage_bps': 30,
        'fees_bps': 5,
        'gas_multiplier': 1.0,
        'max_trade_usd': 50000,
        # HFT optional
        # 'base_fee_gwei': 2.0,
        # 'priority_tip_gwei': 0.5,
        # 'gas_limit': 250000,
        # 'native_usd': 2.0,
    })
"""
from __future__ import annotations
import typing as t
import numpy as np
import pandas as pd

# ---------------- HFT helpers ----------------

def _hft_costs(
    gross_usd: np.ndarray,
    gas_base_usd: np.ndarray,
    notional_usd: np.ndarray,
    p: dict,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return (gas_usd, bps_cost_usd, net_usd, eff).
    If HFT params present, compute advanced costs; else simple bps+gas.
    """
    # Detect HFT mode by presence of any param
    hft_keys = {
        'base_fee_gwei','priority_tip_gwei','gas_limit','native_usd',
        'lp_fees_bps','router_fees_bps','extra_usd','latency_ms','latency_bps_penalty',
        'failure_prob','friction_bps'
    }
    use_hft = any(k in p for k in hft_keys)

    slippage_bps = float(p.get('slippage_bps', 30.0))
    fees_bps = float(p.get('fees_bps', 5.0))

    if use_hft:
        base_fee_gwei = float(p.get('base_fee_gwei', 0.0))
        tip_gwei = float(p.get('priority_tip_gwei', 0.0))
        gas_limit = float(p.get('gas_limit', 250_000))
        native_usd = float(p.get('native_usd', 1.0))
        lp_fees = float(p.get('lp_fees_bps', 0.0))
        router_fees = float(p.get('router_fees_bps', 0.0))
        extra_usd = float(p.get('extra_usd', 0.0))
        latency_ms = float(p.get('latency_ms', 0.0))
        lat_penalty = float(p.get('latency_bps_penalty', 0.0))
        fail_prob = float(p.get('failure_prob', 0.0))
        friction_bps = float(p.get('friction_bps', 0.0))

        # Gas in USD = (base+tip) * gas_limit * native_price
        gas_price_eth = (base_fee_gwei + tip_gwei) * 1e-9
        gas_usd = gas_price_eth * gas_limit * native_usd
        gas_usd = np.full_like(gross_usd, gas_usd, dtype=float)

        # bps costs
        total_bps = (slippage_bps + fees_bps + lp_fees + router_fees + friction_bps) / 10_000.0
        bps_cost_usd = notional_usd * total_bps

        # latency penalty on gross in bps
        lat_cost = (latency_ms * lat_penalty / 10_000.0) * notional_usd

        net_before_fail = gross_usd - gas_usd - bps_cost_usd - extra_usd - lat_cost
        # Expected value with failure prob (assume zero payoff on failure)
        net_usd = (1.0 - fail_prob) * net_before_fail
        eff = np.where(gas_usd > 0, net_usd / gas_usd, net_usd * 1e6)
        return gas_usd, bps_cost_usd, net_usd, eff

    # Simple path: gas multiplier + bps
    gas_mult = float(p.get('gas_multiplier', 1.0))
    gas_usd = gas_base_usd * gas_mult
    bps_cost = (slippage_bps + fees_bps) / 10_000.0
    bps_cost_usd = notional_usd * bps_cost
    net_usd = gross_usd - gas_usd - bps_cost_usd
    eff = np.where(gas_usd > 0, net_usd / gas_usd, net_usd * 1e6)
    return gas_usd, bps_cost_usd, net_usd, eff


# ---------------- Vector backtest ----------------

def vector_backtest(df: pd.DataFrame, params: dict) -> dict:
    """Compute metrics using vector ops. Expects columns created by data_loader.to_dataframe()."""
    p = dict(params or {})
    min_spread = float(p.get('min_spread_bps', 10.0))
    min_liq = float(p.get('min_liquidity_usd', 10_000.0))
    max_trade = float(p.get('max_trade_usd', 50_000.0))
    notional_cap = float(p.get('notional_cap_usd', float('inf')))

    # Filters
    mask = (df['spread_bps'] >= min_spread) & (df['liquidity_usd'] >= min_liq)
    sub = df.loc[mask].copy()
    if sub.empty:
        return {
            'total_gross_profit': 0.0,
            'total_net_profit': 0.0,
            'winrate': 0.0,
            'avg_profit_per_gas': 0.0,
            'max_drawdown_usd': 0.0,
            'sharpe_proxy': 0.0,
            'count': 0,
        }

    gross = sub['gross_usd'].to_numpy(float)
    gas_base = sub['gas_usd'].to_numpy(float)
    # notional is limited by liquidity and cap
    notional = np.minimum(sub['notional_usd'].to_numpy(float), max_trade)
    if np.isfinite(notional_cap) and notional_cap > 0:
        notional = np.minimum(notional, notional_cap)

    gas_usd, bps_cost_usd, net_usd, eff = _hft_costs(gross, gas_base, notional, p)

    # Aggregate metrics
    total_gross = float(np.nansum(gross))
    total_net = float(np.nansum(net_usd))
    wins = float(np.count_nonzero(net_usd > 0))
    count = float(net_usd.shape[0])
    winrate = wins / count if count > 0 else 0.0
    avg_eff = float(np.nanmean(eff)) if eff.size else 0.0

    # Drawdown path (cum PnL over time)
    pnl = pd.Series(net_usd, index=sub['ts'])
    pnl = pnl.sort_index()
    equity = pnl.cumsum()
    roll_max = equity.cummax()
    dd = equity - roll_max
    max_dd = float(dd.min() if not dd.empty else 0.0)

    # Sharpe proxy: mean/std of per-trade net (no annualization)
    mean = float(pnl.mean() if not pnl.empty else 0.0)
    std = float(pnl.std(ddof=1) if pnl.size > 1 else 0.0)
    sharpe = (mean / std) if std > 0 else 0.0

    return {
        'total_gross_profit': round(total_gross, 6),
        'total_net_profit': round(total_net, 6),
        'winrate': round(winrate, 6),
        'avg_profit_per_gas': round(avg_eff, 6),
        'max_drawdown_usd': round(max_dd, 6),
        'sharpe_proxy': round(sharpe, 6),
        'count': int(count),
    }
