/**
 * VTO 服务端入口（负责人 C：M1 规格解析与任务分解 + M3 执行引擎）。
 * 启动：npm run dev（开发） / npm start；端口 PORT 环境变量，默认 3000。
 */
import { createApp } from './app.js';
import { FileStorage } from './services/storage.js';

async function main(): Promise<void> {
  const storage = new FileStorage();
  await storage.init();

  const app = createApp({ planService: storage.plans, runService: storage.runs });
  const port = Number(process.env.PORT ?? 3000);

  app.listen(port, () => {
    console.log(`[vto-server] 已启动: http://localhost:${port}`);
    console.log('[vto-server] 接口: POST /api/decompose | POST /api/plans | POST /api/plans/:id/execute | GET /api/runs/:runId');
  });
}

main().catch((err) => {
  console.error('[vto-server] 启动失败:', err);
  process.exit(1);
});
