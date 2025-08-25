import { ethers } from "ethers";

// ENV: RPC_URL, OWNER_PK, EXECUTOR, ASSET, AMOUNT
// Build encoded params for the two legs and profit check.
// Note: keep calldata opaque; routers/spenders are provider-specific.

type FlashParams = {
  buyRouter: string;
  buySpender: string;
  buyCalldata: string; // 0x...
  sellRouter: string;
  sellSpender: string;
  sellCalldata: string; // 0x...
  tokenBorrowed: string;
  tokenIntermediate: string;
  profitToken: string;
  minProfit: bigint;
};

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
  const signer = new ethers.Wallet(process.env.OWNER_PK!, provider);

  const executor = new ethers.Contract(
    process.env.EXECUTOR!,
    [
      "function initiateFlashArb(address asset,uint256 amount,bytes params,uint16 referralCode) external",
    ],
    signer
  );

  // TODO: fill addresses and pre-built calldata for your two swaps
  const params: FlashParams = {
    buyRouter: "0xBUY_ROUTER",
    buySpender: "0xBUY_SPENDER",
    buyCalldata: "0x",
    sellRouter: "0xSELL_ROUTER",
    sellSpender: "0xSELL_SPENDER",
    sellCalldata: "0x",
    tokenBorrowed: process.env.ASSET!,
    tokenIntermediate: "0xTOKEN_INTERMEDIATE",
    profitToken: process.env.ASSET!, // or a different token
    minProfit: BigInt(10_000_000_000_000), // example wei
  };

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "tuple(address,address,bytes,address,address,bytes,address,address,address,uint256)",
    ],
    [[
      params.buyRouter,
      params.buySpender,
      params.buyCalldata,
      params.sellRouter,
      params.sellSpender,
      params.sellCalldata,
      params.tokenBorrowed,
      params.tokenIntermediate,
      params.profitToken,
      params.minProfit,
    ]]
  );

  const tx = await executor.initiateFlashArb(
    process.env.ASSET!,
    ethers.getBigInt(process.env.AMOUNT!),
    encoded,
    0 // referralCode
  );
  console.log("flashloan tx:", tx.hash);
  const rc = await tx.wait();
  console.log("receipt block:", rc.blockNumber);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
