import os, httpx, pandas as pd, asyncio
from typing import Dict, Any, List

# Base URL and auth
GOLDSKY_API_URL = os.getenv("GOLDSKY_API_URL", "").strip()
GOLDSKY_API_KEY = os.getenv("GOLDSKY_API_KEY", "").strip()
GOLDSKY_MODE = os.getenv("GOLDSKY_MODE", "rest").strip().lower()  # 'rest' or 'graphql'

# Header customization to support different providers (e.g., Authorization Bearer vs X-API-Key)
API_HEADER_NAME = os.getenv("GOLDSKY_API_HEADER", "Authorization").strip()  # e.g., "Authorization" or "X-API-Key"
API_HEADER_PREFIX = os.getenv("GOLDSKY_API_PREFIX", "Bearer ")  # prefix before key; empty string allowed

# Path template for pool reserves; must contain {pool_id}
POOL_RES_PATH = os.getenv("GOLDSKY_POOL_RES_PATH", "pools/{pool_id}/reserves")

# GraphQL-specific settings
GQL_URL = os.getenv("GOLDSKY_GQL_URL", GOLDSKY_API_URL)
# Default query assumes a schema with pool(id) { reserves(first:, orderBy:, orderDirection:) { ... } }
GQL_QUERY = os.getenv(
    "GOLDSKY_GQL_QUERY",
    (
        "query ReserveData($poolId: ID!, $limit: Int!) {\n"
        "  pool(id: $poolId) {\n"
        "    reserves(first: $limit, orderBy: timestamp, orderDirection: desc) {\n"
        "      timestamp\n"
        "      reserve0\n"
        "      reserve1\n"
        "    }\n"
        "  }\n"
        "}"
    ),
)
# Dot-path to items in GraphQL response, default: data.pool.reserves
GQL_ITEMS_PATH = os.getenv("GOLDSKY_GQL_ITEMS_PATH", "data.pool.reserves")

async def fetch_json(path: str, params: Dict[str, Any] | None = None) -> Any:
    if not GOLDSKY_API_URL:
        raise RuntimeError("GOLDSKY_API_URL not set")
    headers: Dict[str, str] = {}
    if GOLDSKY_API_KEY:
        # Compose header according to configured scheme
        headers[API_HEADER_NAME] = f"{API_HEADER_PREFIX}{GOLDSKY_API_KEY}" if API_HEADER_PREFIX is not None else GOLDSKY_API_KEY
    url = f"{GOLDSKY_API_URL.rstrip('/')}/{path.lstrip('/')}"
    # Retry with exponential backoff on network/5xx
    attempts = 3
    delay = 0.5
    last_err: Exception | None = None
    async with httpx.AsyncClient(timeout=20.0) as c:
        for i in range(attempts):
            try:
                r = await c.get(url, params=params or {}, headers=headers)
                r.raise_for_status()
                return r.json()
            except Exception as e:
                last_err = e
                # 4xx likely won't succeed on retry; only retry on 5xx/transport
                try:
                    status = getattr(e, 'response', None).status_code if hasattr(e, 'response') and e.response else None
                except Exception:
                    status = None
                if status is not None and 400 <= int(status) < 500:
                    break
                await asyncio.sleep(delay)
                delay *= 2
    raise RuntimeError(f"Goldsky REST fetch failed url={url} params={params} err={last_err}")

async def get_pool_history(pool_id: str, limit: int = 1000) -> pd.DataFrame:
    def _extract_core_fields(items: List[Dict[str, Any]]) -> pd.DataFrame:
        # Normalize to required keys: timestamp, reserve0, reserve1
        out: List[Dict[str, Any]] = []
        for it in items or []:
            try:
                ts = it.get("timestamp")
                r0 = it.get("reserve0")
                r1 = it.get("reserve1")
                if ts is None and "blockTimestamp" in it:
                    ts = it.get("blockTimestamp")
                # Coerce types if needed
                if isinstance(ts, str) and ts.isdigit():
                    ts = int(ts)
                out.append({"timestamp": ts, "reserve0": r0, "reserve1": r1})
            except Exception:
                # Best-effort extraction; skip malformed items
                continue
        # If extraction produced at least one meaningful row, use it; otherwise return original
        valid = [o for o in out if o.get("timestamp") is not None]
        return pd.DataFrame(valid) if valid else pd.DataFrame(items)
    if GOLDSKY_MODE == "graphql":
        # GraphQL POST to GQL_URL
        if not GQL_URL:
            raise RuntimeError("GOLDSKY_GQL_URL (or GOLDSKY_API_URL) not set for GraphQL mode")
        headers: Dict[str, str] = {}
        if GOLDSKY_API_KEY:
            headers[API_HEADER_NAME] = f"{API_HEADER_PREFIX}{GOLDSKY_API_KEY}" if API_HEADER_PREFIX is not None else GOLDSKY_API_KEY
        payload = {"query": GQL_QUERY, "variables": {"poolId": pool_id, "limit": int(limit)}}
        # Retry with exponential backoff for GraphQL POST
        attempts = 3
        delay = 0.5
        last_err: Exception | None = None
        async with httpx.AsyncClient(timeout=20.0) as c:
            for i in range(attempts):
                try:
                    r = await c.post(GQL_URL, json=payload, headers=headers)
                    r.raise_for_status()
                    data = r.json()
                    # GraphQL-level errors array
                    if isinstance(data, dict) and data.get('errors'):
                        raise RuntimeError(f"GraphQL errors: {data.get('errors')}")
                    break
                except Exception as e:
                    last_err = e
                    try:
                        status = getattr(e, 'response', None).status_code if hasattr(e, 'response') and e.response else None
                    except Exception:
                        status = None
                    if status is not None and 400 <= int(status) < 500:
                        # Auth/schema errors won't be fixed by retry
                        raise
                    await asyncio.sleep(delay)
                    delay *= 2
            else:
                raise RuntimeError(f"Goldsky GraphQL fetch failed url={GQL_URL} err={last_err}")
        # Traverse dot-path to get items
        node: Any = data
        for part in GQL_ITEMS_PATH.split('.'):
            if part:
                node = node.get(part) if isinstance(node, dict) else None
                if node is None:
                    break
        items: List[Dict[str, Any]] = node if isinstance(node, list) else []
        return _extract_core_fields(items)
    else:
        # REST mode
        path = POOL_RES_PATH.format(pool_id=pool_id)
        data = await fetch_json(path, {"limit": limit})
        items = data.get("items", data) if isinstance(data, dict) else data
        return _extract_core_fields(items)
