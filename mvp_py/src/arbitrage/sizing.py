from typing import Tuple

def max_in_for_slip_bps(reserve_in: float, reserve_out: float, slip_bps: float) -> float:
    """
    For constant product AMM: price impact ~ dx / (Rin + dx)
    We find dx such that impact <= slip_bps.
    Approx: dx <= Rin * slip_bps/10000 / (1 - slip_bps/10000)
    """
    s = float(slip_bps)/10000.0
    if s <= 0 or s >= 1:
        return 0.0
    return float(reserve_in) * s / (1.0 - s)

def uni_v2_out_given_in(dx: float, Rin: float, Rout: float, fee_bps: float) -> float:
    fee = 1.0 - float(fee_bps)/10000.0
    dx_f = float(dx) * fee
    return (dx_f * float(Rout)) / (float(Rin) + dx_f)

def uni_v2_in_given_out(dy: float, Rin: float, Rout: float, fee_bps: float) -> float:
    fee = 1.0 - float(fee_bps)/10000.0
    return (float(Rin) * float(dy)) / (fee * (float(Rout) - float(dy)))
