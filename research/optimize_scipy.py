"""
Parameter optimization utilities using SciPy.

- Calibrates HFT cost parameters to data (optional)
- Optimizes backtest parameters for objectives like Net/(1+DD), Sharpe proxy

Usage:
    from research.data_loader import fetch_recent, to_dataframe
    from research.optimize_scipy import optimize_params

    rows = fetch_recent()
    df = to_dataframe(rows)
    best, history = optimize_params(df, init_params={
        'min_spread_bps': 10,
        'min_liquidity_usd': 10000,
        'slippage_bps': 30,
        'fees_bps': 5,
        'gas_multiplier': 1.0,
        'max_trade_usd': 50000,
    }, objective='net_over_dd')
"""
from __future__ import annotations
import typing as t
import numpy as np
import pandas as pd
from scipy.optimize import minimize

from .backtest_np import vector_backtest


def _objective_wrapper(df: pd.DataFrame, objective: str):
    def score(params_vec: np.ndarray, keys: list[str]) -> float:
        p = {k: float(v) for k, v in zip(keys, params_vec)}
        m = vector_backtest(df, p)
        if objective == 'winrate':
            return -float(m.get('winrate', 0.0))
        if objective == 'sharpe_proxy':
            return -float(m.get('sharpe_proxy', 0.0))
        if objective == 'avg_profit_per_gas':
            return -float(m.get('avg_profit_per_gas', 0.0))
        if objective == 'net_over_dd':
            net = float(m.get('total_net_profit', 0.0))
            dd = abs(float(m.get('max_drawdown_usd', 0.0)))
            return -(net / (1.0 + dd))
        # default: maximize net
        return -float(m.get('total_net_profit', 0.0))
    return score


def optimize_params(
    df: pd.DataFrame,
    init_params: dict,
    bounds: dict | None = None,
    objective: str = 'total_net_profit',
    keys: list[str] | None = None,
) -> tuple[dict, list[tuple[dict, dict]]]:
    """Optimize a subset of params using SciPy L-BFGS-B.

    Returns (best_params, history) where history contains (params, metrics).
    """
    if keys is None:
        keys = [
            'min_spread_bps', 'min_liquidity_usd', 'slippage_bps', 'fees_bps',
            'gas_multiplier', 'max_trade_usd', 'notional_cap_usd'
        ]
    p0 = np.array([float(init_params.get(k, 0.0)) for k in keys], dtype=float)
    bspec = []
    bounds = bounds or {}
    for k in keys:
        lo, hi = bounds.get(k, (None, None))
        if lo is None: lo = -1e6
        if hi is None: hi = 1e6
        bspec.append((float(lo), float(hi)))

    history: list[tuple[dict, dict]] = []
    obj = _objective_wrapper(df, objective)

    def cb(xk: np.ndarray):
        params = {k: float(v) for k, v in zip(keys, xk)}
        m = vector_backtest(df, params)
        history.append((params, m))

    res = minimize(lambda x: obj(x, keys), p0, method='L-BFGS-B', bounds=bspec, callback=cb, options={'maxiter': 50})
    best = {k: float(v) for k, v in zip(keys, res.x)}
    best_metrics = vector_backtest(df, best)
    history.append((best, best_metrics))
    return best, history
