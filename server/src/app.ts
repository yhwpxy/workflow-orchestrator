/**
 * Express 应用装配（规格 3.2 服务端分层：路由层 → 服务层 → 执行引擎 → 存储层）。
 * 依赖注入式构建，便于测试与替换存储实现。
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ApiError } from './errors.js';
import { RunManager } from './engine/runManager.js';
import { buildRouter, type AppDeps } from './routes.js';
import type { RunService, PlanService } from './services/storage.js';

export function createApp(deps: { planService: PlanService; runService: RunService }): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' })); // 规格文本 ≤200KB，留余量

  const runManager = new RunManager(deps.runService);
  const routerDeps: AppDeps = { ...deps, runManager };
  app.use(buildRouter(routerDeps));

  // 404
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ code: 40400, message: '接口不存在' });
  });

  // 统一错误体 { code, message, details? }（规格 6.1/6.3）
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.httpStatus).json({
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
      return;
    }
    console.error('[server] 未处理异常:', err);
    res.status(500).json({ code: 50000, message: '服务器内部错误' });
  });

  return app;
}
