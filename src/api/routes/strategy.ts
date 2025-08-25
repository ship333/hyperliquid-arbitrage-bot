import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { zBacktestRun, zCreateStrategy, zUpdateStrategy } from '../../types/strategy';
import { strategyStore } from '../../storage/strategyStore';
import { checkApproval } from '../../policy/strategyGate';

const router = Router();

// Create strategy
router.post('/', async (req: Request, res: Response) => {
  try {
    const input = zCreateStrategy.parse(req.body);
    const created = await strategyStore.createStrategy(input);
    res.status(201).json(created);
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'invalid_input', details: e.errors, timestamp: Date.now() });
    console.error(e);
    res.status(500).json({ error: 'internal_error', timestamp: Date.now() });
  }
});

// List strategies
router.get('/', async (_req: Request, res: Response) => {
  const items = await strategyStore.listStrategies();
  res.json(items);
});

// Get strategy
router.get('/:id', async (req: Request, res: Response) => {
  const item = await strategyStore.getStrategy(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found', timestamp: Date.now() });
  res.json(item);
});

// Update strategy (limited when approved)
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const patch = zUpdateStrategy.parse(req.body);
    const updated = await strategyStore.updateStrategy(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'not_found', timestamp: Date.now() });
    res.json(updated);
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'invalid_input', details: e.errors, timestamp: Date.now() });
    console.error(e);
    res.status(500).json({ error: 'internal_error', timestamp: Date.now() });
  }
});

// Archive strategy
router.delete('/:id', async (req: Request, res: Response) => {
  const updated = await strategyStore.archiveStrategy(req.params.id);
  if (!updated) return res.status(404).json({ error: 'not_found', timestamp: Date.now() });
  res.json(updated);
});

// Register backtest
router.post('/:id/backtest', async (req: Request, res: Response) => {
  try {
    const input = zBacktestRun.parse(req.body);
    const s = await strategyStore.getStrategy(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found', timestamp: Date.now() });
    const run = await strategyStore.addBacktest(req.params.id, input);
    res.status(201).json(run);
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'invalid_input', details: e.errors, timestamp: Date.now() });
    console.error(e);
    res.status(500).json({ error: 'internal_error', timestamp: Date.now() });
  }
});

// Approve strategy (or reject based on policy)
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const s = await strategyStore.getStrategy(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found', timestamp: Date.now() });
    const runs = await strategyStore.listBacktests(s.id);
    if (!runs.length) return res.status(400).json({ error: 'no_backtests', timestamp: Date.now() });
    const latest = runs.sort((a, b) => b.createdAt - a.createdAt)[0];
    const decision = checkApproval(latest.coverageHours, latest.stats);
    const updated = await strategyStore.approveStrategy(s.id, {
      at: Date.now(),
      status: decision.status,
      coverageHours: decision.coverageHours,
      metrics: latest.stats,
      reason: decision.reason,
    });
    res.json({
      status: decision.status,
      coverageHours: decision.coverageHours,
      thresholds: decision.thresholds,
      reason: decision.reason,
      strategy: updated,
    });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: 'internal_error', timestamp: Date.now() });
  }
});

export default router;
