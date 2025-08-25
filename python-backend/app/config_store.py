import json
import os
from typing import Any
from .models import Config

CONFIG_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, "config", "runtime_config.json"))

def _ensure_dir(path: str) -> None:
    d = os.path.dirname(path)
    if not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)

async def load_config() -> Config:
    # lightweight sync I/O is fine on startup, file is tiny
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return Config(**data)
    except FileNotFoundError:
        cfg = Config()
        await save_config(cfg)
        return cfg
    except Exception:
        # fallback to defaults on parse errors
        return Config()

async def save_config(cfg: Config) -> None:
    _ensure_dir(CONFIG_PATH)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg.dict(), f, indent=2)
