import asyncio
import os
import random
from datetime import datetime
import httpx

BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8000")
POST_URL = f"{BACKEND_URL}/api/ingest/opportunity"

PAIRS = ["PRJX/USDC", "HYPE/USDC", "PRJX/ETH"]
ROUTES = ["PRJX->HyperSwap", "HyperSwap->PRJX"]

async def send_once(client: httpx.AsyncClient) -> None:
    pair = random.choice(PAIRS)
    opp = {
        "pair": pair,
        "spread_bps": round(random.uniform(5.0, 35.0), 2),
        "est_gas_usd": round(random.uniform(0.05, 1.2), 2),
        "est_profit_usd": round(random.uniform(-1.0, 30.0), 2),
        "liquidity_usd": round(random.uniform(10_000, 300_000), 2),
        "confidence": round(random.uniform(0.6, 0.99), 2),
        "route": random.choice(ROUTES),
        "note": f"shim@{datetime.utcnow().isoformat()}"
    }
    try:
        r = await client.post(POST_URL, json=opp, timeout=5.0)
        r.raise_for_status()
    except Exception as e:
        # Best-effort logging; keep going
        print(f"ingest error: {e}")

async def main():
    interval = float(os.getenv("SHIM_INTERVAL", "0.8"))
    async with httpx.AsyncClient() as client:
        while True:
            await send_once(client)
            await asyncio.sleep(interval)

if __name__ == "__main__":
    asyncio.run(main())
