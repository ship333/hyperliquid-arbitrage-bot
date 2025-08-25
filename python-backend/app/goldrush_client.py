import os
from typing import Any, Dict, Optional

import httpx


class GoldRushClient:
    """Minimal GoldRush SDK wrapper for HyperEVM data.

    Notes:
    - Endpoints are thin wrappers; if unavailable, we return None and let callers fallback.
    - To reduce latency, callers should cache results between requests when feasible.
    """

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None, timeout: float = 8.0):
        self.api_key = api_key or os.getenv("GOLD_RUSH_API_KEY", "")
        self.base_url = (base_url or os.getenv("GOLD_RUSH_BASE_URL") or "https://goldrush.dev")
        self._client = httpx.AsyncClient(timeout=timeout)

    def _headers(self) -> Dict[str, str]:
        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def _rpc_gas_price(self) -> Optional[int]:
        """Fallback: fetch gas price via JSON-RPC eth_gasPrice using RPC_URL env."""
        rpc = os.getenv("RPC_URL", "").strip() or os.getenv("HYPEREVM_RPC", "").strip()
        if not rpc:
            return None
        try:
            payload = {"jsonrpc": "2.0", "method": "eth_gasPrice", "params": [], "id": 1}
            r = await self._client.post(rpc, json=payload, headers={"Content-Type": "application/json"})
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict) and isinstance(data.get("result"), str):
                return int(data["result"], 16)
        except Exception:
            return None
        return None

    async def _coingecko_price_usd(self) -> Optional[float]:
        """Fallback: CoinGecko simple price using COINGECKO_NATIVE_ID env."""
        coin_id = os.getenv("COINGECKO_NATIVE_ID", "").strip()
        if not coin_id:
            return None
        try:
            url = f"https://api.coingecko.com/api/v3/simple/price?ids={coin_id}&vs_currencies=usd"
            r = await self._client.get(url)
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict) and coin_id in data and isinstance(data[coin_id], dict):
                val = data[coin_id].get("usd")
                return float(val) if val is not None else None
        except Exception:
            return None
        return None

    async def get_native_gas_price_wei(self, chain: str = "hyperevm-mainnet") -> Optional[int]:
        """Return current native gas price in wei for the chain."""
        try:
            # Placeholder endpoint path; adjust to official GoldRush gas endpoint when known.
            url = f"{self.base_url}/api/v1/{chain}/gas-price"
            r = await self._client.get(url, headers=self._headers())
            r.raise_for_status()
            data = r.json()
            # Expecting something like {"gas_price_wei": 1234567890}
            val = int(data.get("gas_price_wei")) if isinstance(data, dict) and data.get("gas_price_wei") is not None else None
            if val is not None:
                return val
        except Exception:
            pass
        # Fallback to RPC gas price
        return await self._rpc_gas_price()

    async def get_native_price_usd(self, chain: str = "hyperevm-mainnet") -> Optional[float]:
        """Return USD price for the chain's native token (e.g., HYPE)."""
        # Immediate override via env for MVP
        try:
            override = os.getenv("GOLD_RUSH_NATIVE_PRICE_USD", "").strip()
            if override:
                return float(override)
        except Exception:
            pass
        try:
            url = f"{self.base_url}/api/v1/{chain}/native-price-usd"
            r = await self._client.get(url, headers=self._headers())
            r.raise_for_status()
            data = r.json()
            # Expecting {"price_usd": 1.23}
            val = float(data.get("price_usd")) if isinstance(data, dict) and data.get("price_usd") is not None else None
            if val is not None:
                return val
        except Exception:
            pass
        # Fallback to CoinGecko if configured, else last-resort: 1.0
        cg = await self._coingecko_price_usd()
        if cg is not None:
            return cg
        return 1.0

    async def estimate_tx_gas_usd(self, chain: str = "hyperevm-mainnet", gas_limit: int = 250_000) -> Optional[float]:
        """Estimate USD cost for a transaction with the given gas_limit.

        gas_usd = gas_price_wei * gas_limit / 1e18 * native_price_usd
        """
        try:
            gp_wei = await self.get_native_gas_price_wei(chain)
            price_usd = await self.get_native_price_usd(chain)
            if gp_wei is None or price_usd is None:
                return None
            eth_cost = (gp_wei * gas_limit) / 1e18
            return float(eth_cost * price_usd)
        except Exception:
            return None
