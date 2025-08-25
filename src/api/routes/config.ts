import { Router, Request, Response } from 'express';
import { env } from '../../config/env';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({
    policy: {
      minBacktestHours: env.MIN_BACKTEST_HOURS,
      minPSuccess: env.MIN_P_SUCCESS,
      minEvAdjUsd: env.MIN_EV_ADJ_USD,
      maxDrawdown: env.MAX_DRAWDOWN,
    },
    api: {
      totalFeesBps: env.TOTAL_FEES_BPS,
    },
    // Safe exposure only; no secrets returned
    updatedAt: Date.now(),
  });
});

export default router;
