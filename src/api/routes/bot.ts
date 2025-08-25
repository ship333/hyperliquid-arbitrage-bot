import { Router, Request, Response } from 'express';
import { strategyStore } from '../../storage/strategyStore';

const router = Router();

// Derive simple status for now
router.get('/status', async (_req: Request, res: Response) => {
  const approved = await strategyStore.listApprovedByKind('triangular'); // placeholder kind aggregation
  const approvedAll = (await strategyStore.listStrategies()).filter(s => s.status === 'approved');
  res.json({
    running: false, // no lifecycle manager yet
    mode: 'idle',
    approvedStrategies: approvedAll.map(s => s.id),
    updatedAt: Date.now(),
  });
});

// Control stubs
const notImplemented = (_req: Request, res: Response) => res.status(501).json({ ok: false, reason: 'not_implemented', timestamp: Date.now() });
router.post('/start', notImplemented);
router.post('/stop', notImplemented);
router.post('/pause', notImplemented);
router.post('/resume', notImplemented);
router.post('/emergency-stop', notImplemented);

export default router;
