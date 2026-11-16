/**
 * REST 接口测试（规格第 6 章：主链路 + 错误路径）。
 * 启动临时端口实例，用原生 fetch 走真实 HTTP。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { FileStorage } from '../src/services/storage.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { Plan, Run, RunStatus, TaskSpec } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const specText = readFileSync(path.join(here, '../examples/login-spec.md'), 'utf-8');
const loginPlan = JSON.parse(
  readFileSync(path.join(here, '../examples/login-plan.json'), 'utf-8'),
) as Plan;

let server: Server;
let baseUrl: string;
const TERMINAL: RunStatus[] = ['SUCCESS', 'FAILED', 'CANCELED'];

beforeAll(async () => {
  const storage = new FileStorage(path.join(here, '.tmp-storage'));
  await storage.init();
  const app = createApp({ planService: storage.plans, runService: storage.runs });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function api(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

async function waitTerminal(runId: string, timeoutMs = 15000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await api('GET', `/api/runs/${runId}`);
    if (TERMINAL.includes(json.status)) return json as Run;
    if (Date.now() > deadline) throw new Error('运行超时未达终态');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 串行长任务方案（start → task(duration) → end） */
function makeSlowPlan(id: string, name: string, duration: number): Plan {
  return {
    id,
    name,
    version: '1.0',
    nodes: [
      { id: 's', type: 'start', x: 0, y: 0, props: {} },
      { id: 't', type: 'task', x: 100, y: 0, props: { name: '长任务', duration } },
      { id: 'e', type: 'end', x: 200, y: 0, props: {} },
    ],
    edges: [
      { id: 'e1', source: 's', target: 't' },
      { id: 'e2', source: 't', target: 'e' },
    ],
    createdAt: loginPlan.createdAt,
    updatedAt: loginPlan.updatedAt,
  };
}

describe('GET /api/health', () => {
  it('返回 ok', async () => {
    const { status, json } = await api('GET', '/api/health');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });
});

describe('POST /api/decompose（M1）', () => {
  it('附录 A 规格分解为 TaskSpec', async () => {
    const { status, json } = await api('POST', '/api/decompose', { text: specText });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const ts = json.taskSpec as TaskSpec;
    expect(ts.detectedFormat).toBe('markdown');
    expect(ts.tasks).toHaveLength(9);
    expect(ts.tasks[4]).toMatchObject({ type: 'condition', expression: 'passed == true' });
  });

  it('缺少文本 → 40003', async () => {
    const { status, json } = await api('POST', '/api/decompose', {});
    expect(status).toBe(400);
    expect(json.code).toBe(40003);
  });
});

describe('方案存取（M4 存储桩）', () => {
  it('保存 → 列表 → 详情 → 删除', async () => {
    const saved = await api('POST', '/api/plans', loginPlan);
    expect(saved.status).toBe(200);
    expect(saved.json.id).toBe(loginPlan.id);

    const list = await api('GET', '/api/plans');
    expect(list.json.some((p: { id: string }) => p.id === loginPlan.id)).toBe(true);
    expect(list.json[0]).toMatchObject({ nodeCount: 10 });

    const detail = await api('GET', `/api/plans/${loginPlan.id}`);
    expect(detail.json.name).toBe('用户登录功能编排');

    expect((await api('DELETE', `/api/plans/${loginPlan.id}`)).json.ok).toBe(true);
    expect((await api('GET', `/api/plans/${loginPlan.id}`)).status).toBe(404);
  });

  it('结构非法 → 40001', async () => {
    const { status, json } = await api('POST', '/api/plans', { name: '缺 id' });
    expect(status).toBe(400);
    expect(json.code).toBe(40001);
  });

  it('高版本方案拒绝载入（4.3.3）', async () => {
    const future = { ...loginPlan, id: 'plan_future', version: '2.0' };
    const { json } = await api('POST', '/api/plans', future);
    expect(json.code).toBe(40001);
    expect(json.message).toMatch(/更新版本/);
  });
});

describe('执行链路（M3：execute → poll → 终态，AC-06/08/09 前置）', () => {
  it('校验失败 → 40002 且 details 定位到节点', async () => {
    const cyclic: Plan = {
      ...loginPlan,
      id: 'plan_cycle',
      edges: [...loginPlan.edges, { id: 'e_bad', source: 'n9', target: 'n5' }],
    };
    await api('POST', '/api/plans', cyclic);
    const { status, json } = await api('POST', '/api/plans/plan_cycle/execute');
    expect(status).toBe(400);
    expect(json.code).toBe(40002);
    expect(json.message).toMatch(/校验失败/);
    const r2 = json.details.find((d: { rule: string }) => d.rule === 'R2');
    expect(r2.nodeId).toBeDefined();
  });

  it('完整执行示例方案并轮询到 SUCCESS', async () => {
    await api('POST', '/api/plans', loginPlan);
    const { status, json } = await api('POST', `/api/plans/${loginPlan.id}/execute`);
    expect(status).toBe(200);
    const runId = json.runId as string;

    // 增量轮询：since 之前只拿增量日志
    const inc = await api('GET', `/api/runs/${runId}?since=0`);
    expect(inc.json.logs.length).toBeGreaterThanOrEqual(0);

    const run = await waitTerminal(runId);
    expect(run.status).toBe('SUCCESS');
    expect(run.nodeStates.n5.status).toBe('SUCCESS');
    expect(run.nodeStates.n7.status).toBe('SUCCESS'); // true 分支
    expect(run.nodeStates.n8.status).toBe('SKIPPED'); // false 分支
    expect(run.nodeStates.n10.status).toBe('SUCCESS');

    // since 增量：返回 seq > since 的日志
    const firstSeq = run.logs[0]?.seq ?? 0;
    const after = await api('GET', `/api/runs/${runId}?since=${firstSeq}`);
    expect(after.json.logs.every((l: { seq: number }) => l.seq > firstSeq)).toBe(true);
    expect(after.json.nodeStates.n1).toBeDefined(); // nodeStates 始终完整返回
  });

  it('方案正在执行中重复执行 → 40901', async () => {
    const minimal = makeSlowPlan('plan_slow', '慢方案', 1000);
    await api('POST', '/api/plans', minimal);
    const first = await api('POST', '/api/plans/plan_slow/execute');
    expect(first.status).toBe(200);
    const second = await api('POST', '/api/plans/plan_slow/execute');
    expect(second.status).toBe(409);
    expect(second.json.code).toBe(40901);
    await waitTerminal(first.json.runId);
  });

  it('停止运行 → CANCELED', async () => {
    await api('POST', '/api/plans', makeSlowPlan('plan_cancel', '待停止方案', 5000));
    const { json } = await api('POST', '/api/plans/plan_cancel/execute');
    await new Promise((r) => setTimeout(r, 200));
    const cancelled = await api('POST', `/api/runs/${json.runId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.status).toBe('CANCELED');
  });

  it('不存在的运行/方案 → 40402 / 40401', async () => {
    expect((await api('GET', '/api/runs/run_missing')).json.code).toBe(40402);
    expect((await api('POST', '/api/plans/plan_missing/execute')).json.code).toBe(40401);
  });
});
