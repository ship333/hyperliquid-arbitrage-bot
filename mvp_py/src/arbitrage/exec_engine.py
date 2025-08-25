import os, httpx
from typing import Optional, Dict, Any, Tuple

class ExecEngine:
    def __init__(self, rpc_url: str, privkey_hex: Optional[str]=None, chain_id: int=1, private_tx: bool=False):
        self.rpc=rpc_url; self.priv=privkey_hex; self.chain_id=chain_id; self.private_tx=private_tx

    async def _rpc(self, method: str, params: list):
        async with httpx.AsyncClient(timeout=8.0) as c:
            r=await c.post(self.rpc,json={"jsonrpc":"2.0","id":1,"method":method,"params":params})
            r.raise_for_status(); return r.json()["result"]

    async def nonce(self, sender: str) -> int:
        n=await self._rpc("eth_getTransactionCount",[sender,"pending"]); return int(n,16)

    async def estimate_gas(self, tx: Dict[str,Any]) -> int:
        g=await self._rpc("eth_estimateGas",[tx]); return int(g,16)

    async def call_static(self, tx: Dict[str,Any]) -> Tuple[bool,str]:
        try:
            _=await self._rpc("eth_call",[tx,"latest"])
            return True,"OK"
        except httpx.HTTPError as e:
            return False,f"http error: {e}"
        except Exception as e:
            return False,str(e)

    async def send_raw(self, raw_tx: str) -> str:
        if self.private_tx:
            # TODO: post raw_tx to your relay endpoint
            raise NotImplementedError("Private relay not configured")
        h=await self._rpc("eth_sendRawTransaction",[raw_tx]); return h

    async def execute_route(self, built_tx: Dict[str,Any], signer) -> Dict[str,Any]:
        """
        built_tx must include: to, data, value, from (sender)
        signer: object with sign_tx(tx_dict)->raw_tx
        """
        tx=dict(built_tx)
        tx.setdefault("value","0x0")
        tx.setdefault("from", getattr(signer, 'address', os.getenv("BOT_ADDRESS","0xYourAddress")))

        # Estimate gas + simulate
        gas = await self.estimate_gas(tx); tx["gas"]=hex(gas)
        ok,reason = await self.call_static(tx)
        if not ok: return {"ok":False,"stage":"simulate","reason":reason}

        # Sign & send
        if os.getenv("EXECUTE_DRY_RUN","1") == "1":
            return {"ok":True,"stage":"dry_run","gas":gas}

        raw = signer.sign_tx(tx, chain_id=self.chain_id)
        txhash = await self.send_raw(raw)
        return {"ok":True,"stage":"sent","gas":gas,"txhash":txhash}
