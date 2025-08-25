from __future__ import annotations
from dataclasses import dataclass
from typing import Optional
import math


@dataclass
class GasInputs:
    base_fee_gwei: float           # average recent base fee
    priority_tip_gwei: float       # tip for inclusion
    gas_limit: int                 # expected gas units
    native_usd: float              # ETH/USD (or native)
    max_gas_usd_per_trade: float = 1e9

    def gas_usd(self) -> float:
        fee_gwei = float(self.base_fee_gwei) + float(self.priority_tip_gwei)
        usd = fee_gwei * 1e9 * int(self.gas_limit) / 1e18 * float(self.native_usd)
        return float(min(usd, self.max_gas_usd_per_trade))


@dataclass
class LatencyInputs:
    decision_to_submit_ms: int = 250      # time from signal to tx sign/broadcast
    submit_to_inclusion_blocks: int = 1   # blocks until inclusion
    seconds_per_block: float = 1.0        # L2 default; set ~12 for mainnet
    k_vol: float = 0.0                    # $ adverse drift per sqrt(second) per $1 notional
    notional_beta: float = 1.0            # linear coefficient on notional for drift

    def inclusion_seconds(self) -> float:
        return (float(self.decision_to_submit_ms)/1000.0) + float(self.submit_to_inclusion_blocks)*float(self.seconds_per_block)

    def adverse_selection_usd(self, notional_usd: float) -> float:
        # Simple Brownian-drift style penalty: k * sqrt(Δt) * beta * notional
        dt = max(self.inclusion_seconds(), 1e-6)
        return float(self.k_vol) * math.sqrt(dt) * float(self.notional_beta) * float(notional_usd)


@dataclass
class Frictions:
    lp_fees_bps: float = 0.0
    router_fees_bps: float = 0.0
    extra_usd: float = 0.0               # MEV tip, relayer, etc.


def net_after_fees(gross_usd: float, fr: Frictions) -> float:
    fee_mult = 1.0 - (float(fr.lp_fees_bps) + float(fr.router_fees_bps))/10000.0
    return float(gross_usd) * fee_mult - float(fr.extra_usd)


def expected_net_usd(gross_usd: float, notional_usd: float, gas: GasInputs, lat: LatencyInputs, fr: Frictions) -> float:
    # (1) fees, (2) gas, (3) adverse selection
    after_fees = net_after_fees(gross_usd, fr)
    gas_cost = gas.gas_usd()
    adv = lat.adverse_selection_usd(notional_usd)
    return float(after_fees) - float(gas_cost) - float(adv)


def apply_fail_probability(net_usd: float, gas_usd: float, fail_prob: float) -> float:
    """
    With probability fail_prob, we lose gas (no PnL).
    Expected value = (1-p)*net + p*(-gas)
    """
    p = max(0.0, min(1.0, float(fail_prob)))
    return float((1.0 - p) * float(net_usd) + p * (-float(gas_usd)))
