import os, time, httpx
from typing import Optional

# Simple gas oracle with 3 sources:
#  1) ETH_GAS_WEI env override
#  2) JSON-RPC eth_gasPrice
#  3) Public REST fallback (optional)

class GasOracle:
    def __init__(self, rpc_url: str, fallback_url: Optional[str]=None, safety_mult: float = 1.2):
        self.rpc_url = rpc_url
        self.fallback_url = fallback_url
        self.safety_mult = safety_mult
        self._last=(0,0)

    async def wei(self) -> int:
        override=os.getenv("ETH_GAS_WEI")
        if override:
            try:
                return int(override)
            except Exception:
                pass
        now=int(time.time())
        if now-self._last[0] < 3:
            return self._last[1]
        # RPC
        try:
            async with httpx.AsyncClient(timeout=2.5) as c:
                r=await c.post(self.rpc_url,json={"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":1})
                r.raise_for_status()
                v=int(r.json()["result"],16)
                v=int(v*self.safety_mult)
                self._last=(now,v); return v
        except Exception:
            pass
        # Fallback (optional)
        if self.fallback_url:
            try:
                async with httpx.AsyncClient(timeout=2.5) as c:
                    r=await c.get(self.fallback_url)
                    r.raise_for_status()
                    g=int(float(r.json()["standard"]) * 1e9)  # gwei -> wei
                    v=int(g*self.safety_mult)
                    self._last=(now,v); return v
            except Exception:
                pass
        # last resort
        return int(30e9)  # 30 gwei
