import { providers } from 'ethers';

let cached: providers.JsonRpcProvider | null = null;

export function getProvider(rpcUrl?: string): providers.JsonRpcProvider {
  if (!cached) {
    const url = rpcUrl || process.env.RPC_URL || 'http://127.0.0.1:8545';
    cached = new providers.JsonRpcProvider(url);
  }
  return cached;
}
