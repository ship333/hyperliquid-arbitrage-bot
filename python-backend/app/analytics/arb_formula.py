from dataclasses import dataclass
from typing import Optional, Dict, Any, Tuple
import numpy as np

@dataclass
class GasModel:
    base_fee_gwei: float
    tip_gwei: float
    native_usd: float
    gas_limit: int
    max_gas_usd_per_trade: float = 1e9
    def usd(self) -> float:
        usd = (self.base_fee_gwei + self.tip_gwei) * 1e9 * self.gas_limit / 1e18 * self.native_usd
        return float(min(usd, self.max_gas_usd_per_trade))

@dataclass
class LatencyModel:
    decision_to_submit_ms: float = 200.0
    submit_to_inclusion_blocks: int = 1
    seconds_per_block: float = 1.0
    k_vol: float = 0.0
    notional_beta: float = 1.0
    def inclusion_seconds(self) -> float:
        return (self.decision_to_submit_ms/1000.0) + self.submit_to_inclusion_blocks*self.seconds_per_block
    def adverse_usd(self, notional_usd: float) -> float:
        dt = max(self.inclusion_seconds(), 1e-6)
        return float(self.k_vol) * np.sqrt(dt) * float(self.notional_beta) * float(notional_usd)

def gross_from_edge_bps(edge_bps: float, notional_usd: float) -> float:
    return (edge_bps/10000.0) * notional_usd

def apply_fees_bps(amount_usd: float, total_fees_bps: float) -> float:
    return amount_usd * (1.0 - total_fees_bps/10000.0)

def expected_net_usd(edge_bps: float, notional_usd: float, total_fees_bps: float, gas_usd: float, adverse_usd: float, extra_usd: float=0.0, fail_prob: float=0.0) -> float:
    gross = gross_from_edge_bps(edge_bps, notional_usd)
    after_fees = apply_fees_bps(gross, total_fees_bps) - extra_usd
    net = after_fees - gas_usd - adverse_usd
    p = max(0.0, min(1.0, fail_prob))
    return (1.0-p)*net + p*(-gas_usd)

def score_hft(net_usd: float, gas_usd: float, seconds: float, w_net: float=1.0, w_ppg: float=0.6, w_pps: float=0.6) -> float:
    ppg = net_usd / max(gas_usd, 1e-9)
    pps = net_usd / max(seconds, 1e-3)
    return w_net*net_usd + w_ppg*ppg + w_pps*pps
