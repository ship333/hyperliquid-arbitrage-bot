import time
from dataclasses import dataclass

@dataclass
class HealthCfg:
    min_tick_hz: float = 2.0
    max_error_rate: float = 0.2   # last 60s
    max_gas_usd: float = 20.0
    stale_ms: int = 3000

class Watchdog:
    def __init__(self, cfg: HealthCfg):
        self.cfg=cfg
        self._ticks=[]; self._errs=[]; self._last_ts=0; self._gas_usd=0.0
        self._paused=False

    def record_tick(self, ts_ms:int): self._ticks.append(ts_ms); self._last_ts=ts_ms; self._trim()
    def record_error(self, ts_ms:int): self._errs.append(ts_ms); self._trim()
    def set_gas_usd(self, v:float): self._gas_usd=float(v)

    def _trim(self):
        now=int(time.time()*1000)
        self._ticks=[t for t in self._ticks if now-t<60000]
        self._errs=[t for t in self._errs if now-t<60000]

    def _tick_hz(self)->float:
        n=len(self._ticks); return n/60.0

    def _err_rate(self)->float:
        n=len(self._errs); return n/max(1,len(self._ticks))

    def should_pause(self)->bool:
        now=int(time.time()*1000)
        stale = (now - self._last_ts) > self.cfg.stale_ms
        return stale or (self._tick_hz()<self.cfg.min_tick_hz) or (self._err_rate()>self.cfg.max_error_rate) or (self._gas_usd>self.cfg.max_gas_usd)
