/**
 * 路由层（规格 6.1 REST API 总览）。
 * 归属标注：/api/decompose 与 /api/runs、执行入口为 M3/M1（负责人 C）；
 * /api/plans 的存取为 M4（负责人 D），此处为可替换的存储桩。
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { decompose } from './engine/decompose/index.js';
import { RunManager } from './engine/runManager.js';
import type { PlanService, RunService } from './services/storage.js';
import { newPlanId } from './services/storage.js';
import type { Plan } from './types.js';

export interface AppDeps {
  planService: PlanService;
  runService: RunService;
  runManager: RunManager;
}

export function buildRouter(deps: AppDeps): Router {
  const router = Router();
  const { planService, runService, runManager } = deps;

  // 健康检查（演示/联调用）
  router.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'vto-server', time: new Date().toISOString() });
  });

  // POST /api/decompose —— 规格文本 → TaskSpec（M1 / C）
  router.post('/api/decompose', (req: Request, res: Response) => {
    const { text, format, source } = (req.body ?? {}) as { text?: string; format?: 'auto' | 'markdown' | 'numbered'; source?: string };
    if (typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ code: 40003, message: '缺少规格文本 text' });
      return;
    }
    if (text.length > 200 * 1024) {
      res.status(400).json({ code: 40003, message: '规格文本超过 200KB 上限' });
      return;
    }
    const taskSpec = decompose(text, { format, source });
    res.json({ ok: true, taskSpec });
  });

  // POST /api/plans —— 新建/更新方案（M4 / D，存储桩）
  router.post('/api/plans', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Partial<Plan> | undefined;
      const plan = { ...body, id: body?.id ?? newPlanId() } as Plan;
      const { id, updatedAt } = await planService.save(plan);
      res.json({ id, updatedAt });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/plans —— 方案索引列表（M4 / D，存储桩）
  router.get('/api/plans', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await planService.list());
    } catch (err) {
      next(err);
    }
  });

  // GET /api/plans/:id —— 方案详情（M4 / D，存储桩）
  router.get('/api/plans/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await planService.get(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/plans/:id —— 删除方案（M4 / D，存储桩）
  router.delete('/api/plans/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await planService.delete(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/plans/:id/execute —— 校验并执行 → runId（M3 / C）
  router.post('/api/plans/:id/execute', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = await planService.get(req.params.id);
      const runId = runManager.start(plan);
      res.json({ runId });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/runs/:runId —— 运行快照（支持 ?since=seq 增量）（M3 / C）
  router.get('/api/runs/:runId', (req: Request, res: Response, next: NextFunction) => {
    try {
      const since = req.query.since !== undefined ? Number(req.query.since) : undefined;
      res.json(runManager.snapshot(req.params.runId, since));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/runs/:runId/cancel —— 停止运行（M3 / C）
  router.post('/api/runs/:runId/cancel', (req: Request, res: Response, next: NextFunction) => {
    try {
      const run = runManager.cancel(req.params.runId);
      res.json({ status: run.status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
