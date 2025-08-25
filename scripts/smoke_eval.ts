// Quick smoke test against TS eval server
// Assumes server running on TS_API_PORT (default 8082). Override via env.

const port = Number(process.env.TS_API_PORT || 8083);
const url = `http://127.0.0.1:${port}/api/eval/batch`;

async function main() {
  const body = {
    items: [
      {
        edgeBps: 25,
        notionalUsd: 10000,
        fees: { totalFeesBps: 8, flashFeeBps: 5, referralBps: 2, executorFeeUsd: 0.5, flashFixedUsd: 0.2 },
        frictions: { gasUsdMean: 0.2, adverseUsdMean: 1.0 },
        latency: { latencySec: 1.2, edgeDecayBpsPerSec: 2.0, baseFillProb: 0.8, theta: 0.15 },
        slippage: { kind: "empirical", k: 0.9, alpha: 1.25, liquidityRefUsd: 1_500_000 },
        failures: { failBeforeFillProb: 0.02, failBetweenLegsProb: 0.01, reorgOrMevProb: 0.0 },
        flashEnabled: true,
        riskAversion: 0.0001,
        capitalUsd: 20000,
      },
    ],
    defaults: { varCvar: false },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
  } catch (e) {
    console.error("smoke_eval error:", e);
    process.exitCode = 1;
  }
}

main();
