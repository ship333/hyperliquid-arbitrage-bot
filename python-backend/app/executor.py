from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict


@dataclass
class SafetyLimits:
    max_amount_in: float = 1_000_000.0
    max_gas_limit: int = 1_000_000
    max_slippage_bps: float = 500.0  # 5%


class TradeExecutor:
    """Minimal trade executor skeleton with safety checks and dry-run support."""

    def __init__(self, limits: SafetyLimits | None = None):
        self.limits = limits or SafetyLimits()

    def _check_safety(self, amount_in: float, gas_limit: int, slippage_bps: float) -> None:
        if amount_in <= 0:
            raise ValueError("amount_in must be positive")
        if amount_in > self.limits.max_amount_in:
            raise ValueError(f"amount_in exceeds safety limit: {amount_in} > {self.limits.max_amount_in}")
        if gas_limit <= 0:
            raise ValueError("gas_limit must be positive")
        if gas_limit > self.limits.max_gas_limit:
            raise ValueError(f"gas_limit exceeds safety limit: {gas_limit} > {self.limits.max_gas_limit}")
        if slippage_bps < 0 or slippage_bps > self.limits.max_slippage_bps:
            raise ValueError(
                f"slippage_bps out of range: {slippage_bps} not in [0, {self.limits.max_slippage_bps}]"
            )

    def quote(self, amount_in: float, slippage_bps: float) -> Dict[str, Any]:
        """Return a conservative quote (worst-case given slippage)."""
        worst_case_out = float(amount_in) * (1.0 - float(slippage_bps) / 10_000.0)
        return {
            "amount_in": float(amount_in),
            "slippage_bps": float(slippage_bps),
            "amount_out_min": float(max(0.0, worst_case_out)),
        }

    def simulate(self, amount_in: float, gas_price_wei: int, gas_limit: int, native_price_usd: float, slippage_bps: float) -> Dict[str, Any]:
        self._check_safety(amount_in, gas_limit, slippage_bps)
        q = self.quote(amount_in, slippage_bps)
        gas_cost_usd = (float(gas_price_wei) / 1e18) * float(native_price_usd) * float(gas_limit)
        # In a real implementation, slippage applies to out token; here we show net in "USD-equivalent" terms only as demo
        net_value_usd = float(amount_in) - float(gas_cost_usd)
        return {
            **q,
            "gas_limit": int(gas_limit),
            "gas_price_wei": int(gas_price_wei),
            "native_price_usd": float(native_price_usd),
            "gas_cost_usd": float(gas_cost_usd),
            "net_value_usd": float(net_value_usd),
        }

    def execute(self, *, dry_run: bool = True, **kwargs: Any) -> Dict[str, Any]:
        if dry_run:
            return {"status": "dry_run", "tx": None, "note": "Execution skipped (dry-run)"}
        # Placeholder for on-chain execution integration (signing, routing, etc.)
        raise NotImplementedError("Live execution not implemented. Enable dry_run for simulation.")
