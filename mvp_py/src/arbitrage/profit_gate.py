from dataclasses import dataclass
from typing import Optional, Dict

@dataclass
class Costs:
    gas_wei: int
    gas_limit: int
    native_usd: float
    router_fee_bps: float = 0.0
    extra_usd: float = 0.0  # e.g. MEV tip, relayer fee

@dataclass
class Quote:
    gross_usd: float     # expected gross profit before gas/fees
    slip_bps: float      # worst case slippage assumed
    lp_fees_bps: float   # total LP fees across route (sum)
    route: str

def net_profit_usd(quote: Quote, costs: Costs) -> float:
    fee_mult = 1.0 - (float(quote.lp_fees_bps) + float(costs.router_fee_bps))/10000.0
    gross_after_fees = float(quote.gross_usd) * fee_mult
    gas_usd = (int(costs.gas_wei) * int(costs.gas_limit)) / 1e18 * float(costs.native_usd)
    return float(gross_after_fees) - float(gas_usd) - float(costs.extra_usd)

def is_viable(quote: Quote, costs: Costs, min_profit_usd: float, max_slip_bps: float) -> bool:
    if float(quote.slip_bps) > float(max_slip_bps):
        return False
    return net_profit_usd(quote, costs) >= float(min_profit_usd)
