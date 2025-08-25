import { Contract } from 'ethers';
import { getProvider } from './providers';
import { IUniswapV3PoolABI } from './univ3_abi';

export type PoolState = {
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  fee: number;
  tickSpacing: number;
};

export async function fetchPoolState(poolAddress: string, rpcUrl?: string): Promise<PoolState> {
  const provider = getProvider(rpcUrl);
  const pool = new Contract(poolAddress, IUniswapV3PoolABI, provider);
  const [slot0, liquidity, fee, tickSpacing] = await Promise.all([
    pool.slot0(),
    pool.liquidity(),
    pool.fee(),
    pool.tickSpacing(),
  ]);
  return {
    sqrtPriceX96: slot0.sqrtPriceX96.toString(),
    tick: Number(slot0.tick),
    liquidity: liquidity.toString(),
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
  };
}

// Placeholder: fetching initialized ticks requires TickLens helper or pool methods via range queries.
// Implementations often use Uniswap's TickLens or subgraph. This is a stub to keep module shape.
export type InitializedTick = { index: number; liquidityNet: string; sqrtPriceX96?: string };

export async function fetchInitializedTicks(_poolAddress: string, _rpcUrl?: string): Promise<InitializedTick[]> {
  // TODO: implement via TickLens/multicall; return empty for now
  return [];
}
