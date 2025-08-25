from __future__ import annotations
from typing import Tuple


def slip_bps_from_dx(dx: float, Rin: float) -> float:
    # Approximate price impact for XYK: dx/(Rin+dx)
    if dx <= 0 or Rin <= 0:
        return 0.0
    impact = float(dx) / (float(Rin) + float(dx))
    return float(impact * 10000.0)


def out_given_in(dx: float, Rin: float, Rout: float, fee_bps: float) -> float:
    fee = 1.0 - float(fee_bps)/10000.0
    dx_eff = float(dx) * fee
    denom = float(Rin) + dx_eff
    if denom <= 0:
        return 0.0
    return (dx_eff * float(Rout)) / denom


def solve_size_for_max_net(
    Rin: float,
    Rout: float,
    fee_bps: float,
    px_out_usd: float,
    slip_cap_bps: float,
    notional_cap_usd: float,
    net_fn,
) -> Tuple[float, float, float]:
    """
    Grid-search the input size (in input token units) that maximizes net_fn(notional_usd).
    Returns: (best_dx_in_units, best_net_usd, slip_at_best_bps)
    """
    if Rin <= 0 or Rout <= 0 or px_out_usd <= 0:
        return 0.0, 0.0, 0.0
    candidates = []
    # conservative slip bound approximation: dx such that slip_bps_from_dx(dx, Rin) <= slip_cap
    if slip_cap_bps > 0:
        # invert approx: slip = dx/(Rin+dx) => dx = slip*Rin/(1-slip)
        s = float(slip_cap_bps)/10000.0
        if s >= 0.999999:
            s = 0.999999
        dx_slip = (float(Rin) * s) / (1.0 - s)
    else:
        dx_slip = float(Rin) * 0.25

    for i in range(1, 25):
        frac = i / 25.0
        dx_guess = min(float(Rin) * frac * 0.25, dx_slip)
        if dx_guess <= 0:
            continue
        dy = out_given_in(dx_guess, Rin, Rout, fee_bps)
        notional_usd = float(dy) * float(px_out_usd)
        if notional_cap_usd > 0 and notional_usd > notional_cap_usd:
            notional_usd = notional_cap_usd
        net_usd = float(net_fn(notional_usd))
        slip_bps = slip_bps_from_dx(dx_guess, Rin)
        candidates.append((net_usd, dx_guess, slip_bps))

    if not candidates:
        return 0.0, 0.0, 0.0
    best = max(candidates, key=lambda t: t[0])
    return float(best[1]), float(best[0]), float(best[2])
