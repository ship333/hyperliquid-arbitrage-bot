import os, httpx
import pandas as pd
from typing import Any

ALCHEMY_RPC_URL = os.getenv("ALCHEMY_RPC_URL", "")

async def rpc(method: str, params: list) -> Any:
    if not ALCHEMY_RPC_URL:
        raise RuntimeError("ALCHEMY_RPC_URL not set")
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.post(ALCHEMY_RPC_URL, json={"jsonrpc":"2.0","id":1,"method":method,"params":params})
        r.raise_for_status()
        return r.json().get("result")

async def get_recent_blocks(n: int = 50) -> pd.DataFrame:
    latest_hex = await rpc("eth_blockNumber", [])
    latest = int(latest_hex, 16)
    rows = []
    for i in range(n):
        num = latest - i
        blk = await rpc("eth_getBlockByNumber", [hex(num), False])
        rows.append({
            "number": int(blk["number"],16),
            "baseFeePerGas_gwei": (int(blk.get("baseFeePerGas","0x0"),16) / 1e9),
            "timestamp": int(blk["timestamp"],16)
        })
    df = pd.DataFrame(rows).sort_values("number").reset_index(drop=True)
    return df

def base_fee_ema(df: pd.DataFrame, span:int=12) -> float:
    if df.empty: return 0.0
    return float(df["baseFeePerGas_gwei"].ewm(span=span, adjust=False).mean().iloc[-1])
