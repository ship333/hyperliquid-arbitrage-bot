import axios from 'axios';

async function main() {
  const base = process.env.API_BASE || 'http://127.0.0.1:8083';
  const kind = process.env.STRAT_KIND || 'triangular';
  const hours = Number(process.env.COVERAGE_HOURS || 26);
  const now = Date.now();
  const start = now - hours * 3600_000;

  console.log(`Seeding strategy on ${base} kind=${kind}, coverage=${hours}h`);

  // 1) Create strategy
  const createRes = await axios.post(`${base}/api/strategy`, {
    name: `Auto ${kind} ${new Date().toISOString()}`,
    kind,
    params: {}
  });
  const strat = createRes.data;
  console.log('Created strategy:', strat.id);

  // 2) Upload backtest
  const btRes = await axios.post(`${base}/api/strategy/${strat.id}/backtest`, {
    startedAt: start,
    endedAt: now,
    stats: {
      evAdjUsd: 10,
      pSuccess: 0.8,
      maxDrawdown: 0,
      hitRate: 0.75,
      pnlUsd: 100,
      samples: 1000
    }
  });
  const run = btRes.data;
  console.log('Backtest added:', run.id, 'coverageHours=', run.coverageHours.toFixed(2));

  // 3) Approve per policy
  const approveRes = await axios.post(`${base}/api/strategy/${strat.id}/approve`);
  console.log('Approval decision:', approveRes.data.status, approveRes.data.reason || '');
  console.log('Thresholds:', approveRes.data.thresholds);

  // 4) Fetch final strategy
  const final = await axios.get(`${base}/api/strategy/${strat.id}`);
  console.log(JSON.stringify(final.data, null, 2));
}

main().catch((e) => {
  if (axios.isAxiosError(e)) {
    console.error('HTTP Error:', e.response?.status, e.response?.data);
  } else {
    console.error(e);
  }
  process.exit(1);
});
