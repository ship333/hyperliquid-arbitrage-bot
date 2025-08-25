from typing import Optional

def usd_from_native(amount_native: float, native_usd: float) -> float:
    return float(amount_native) * float(native_usd)

def apply_fee(amount: float, fee_bps: float) -> float:
    return float(amount) * (1.0 - float(fee_bps)/10000.0)

def add_fee(amount: float, fee_bps: float) -> float:
    return float(amount) * (1.0 + float(fee_bps)/10000.0)
