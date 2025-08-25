"""
Data loading utilities for offline research/backtesting.

- Pulls recent opportunities from the backend `/api/backtest/export` endpoint.
- Converts to pandas DataFrame with typed columns and computed helpers.
- Provides save/load to Parquet/CSV for reproducibility.

Usage:
    from research.data_loader import fetch_recent, to_dataframe
    rows = fetch_recent("http://127.0.0.1:8000", window_minutes=180)
    df = to_dataframe(rows)
"""
from __future__ import annotations
import typing as t
import requests
import pandas as pd
from datetime import datetime

DEFAULT_BACKEND = "http://127.0.0.1:8000"

COLUMNS = [
    "ts",
    "pair",
    "route",
    "chain_name",
    "spread_bps",
    "est_gas_usd",
    "est_profit_usd",
    "liquidity_usd",
    "confidence",
]


def fetch_recent(base_url: str = DEFAULT_BACKEND, window_minutes: int = 180) -> t.List[dict]:
    url = f"{base_url.rstrip('/')}/api/backtest/export?window_minutes={int(window_minutes)}"
    resp = requests.get(url, timeout=20)
    resp.raise_for_status()
    data = resp.json()
    return t.cast(t.List[dict], data.get("rows", []))


def to_dataframe(rows: t.List[dict]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=COLUMNS)
    df = pd.DataFrame(rows)
    # Ensure typed columns and defaults
    def to_ts(x: t.Any) -> pd.Timestamp:
        try:
            return pd.to_datetime(x, utc=True)
        except Exception:
            return pd.Timestamp.utcnow()
    df["ts"] = df.get("ts", pd.Series([None]*len(df))).map(to_ts)
    for col, dtype, default in [
        ("pair", "string", ""),
        ("route", "string", ""),
        ("chain_name", "string", ""),
    ]:
        df[col] = df.get(col, default).fillna(default).astype(dtype)
    for col in ["spread_bps", "est_gas_usd", "est_profit_usd", "liquidity_usd", "confidence"]:
        df[col] = pd.to_numeric(df.get(col, 0.0), errors="coerce").fillna(0.0)
    df = df.sort_values("ts").reset_index(drop=True)

    # helpers
    df["gross_usd"] = df["est_profit_usd"]
    df["gas_usd"] = df["est_gas_usd"]
    df["notional_usd"] = df["liquidity_usd"]
    return df


def save_parquet(df: pd.DataFrame, path: str) -> None:
    df.to_parquet(path, index=False)


def save_csv(df: pd.DataFrame, path: str) -> None:
    df.to_csv(path, index=False)


def load_parquet(path: str) -> pd.DataFrame:
    return pd.read_parquet(path)


def load_csv(path: str) -> pd.DataFrame:
    return pd.read_csv(path, parse_dates=["ts"]) 
