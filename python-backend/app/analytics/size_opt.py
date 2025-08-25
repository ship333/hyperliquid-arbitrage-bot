import numpy as np
from typing import Callable, Tuple
from math import isfinite
from scipy.optimize import minimize_scalar

def xyk_out_given_in(dx: float, Rin: float, Rout: float, fee_bps: float) -> float:
    fee = 1.0 - fee_bps/10000.0
    dx_eff = dx * fee
    return (dx_eff * Rout) / (Rin + dx_eff)

def slip_bps(dx: float, Rin: float) -> float:
    if dx <= 0 or Rin <= 0: return 0.0
    return 10000.0 * dx / (Rin + dx)

def solve_best_dx(
    Rin: float, Rout: float, fee_bps: float,
    px_out_usd: float,
    notional_cap_usd: float,
    slip_cap_bps: float,
    expected_net_fn: Callable[[float], float],
    dx_hi_frac: float = 0.25
) -> Tuple[float, float, float]:
    if Rin<=0 or Rout<=0 or px_out_usd<=0:
        return 0.0, 0.0, 0.0

    dx_slip = (Rin * (slip_cap_bps/10000.0)) / max(1e-9, (1.0 - slip_cap_bps/10000.0))
    dx_max  = min(Rin*dx_hi_frac, dx_slip)

    def obj(dx):
        if dx<=0: return 1e12
        if slip_bps(dx, Rin) > slip_cap_bps: return 1e11
        dy = xyk_out_given_in(dx, Rin, Rout, fee_bps)
        notional = dy * px_out_usd
        if notional > notional_cap_usd: return 1e10
        net = expected_net_fn(notional)
        return -net

    res = minimize_scalar(obj, bounds=(1e-12, dx_max), method="bounded", options={"xatol":1e-9})
    if not res.success or not isfinite(res.x):
        return 0.0, 0.0, 0.0
    best_dx = float(res.x)
    best_dy = xyk_out_given_in(best_dx, Rin, Rout, fee_bps)
    best_notional = best_dy * px_out_usd
    best_slip = slip_bps(best_dx, Rin)
    best_net  = -float(res.fun)
    return best_dx, best_net, best_slip
