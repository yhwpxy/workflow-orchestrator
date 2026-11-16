/**
 * 调度执行器单元测试（规格 4.2.3/4.2.4 + 8.2 调度器测试点 + AC-06/07/08）。
 */
import { describe, expect, it } from 'vitest';
import { RunManager } from '../src/engine/runManager.js';
import {
  edge,
  makePlan,
  minimalPlan,
  node,
  runAndWait,
  sleep,
} from './helpers.js';
import type { RunManager as RM } from '../src/engine/runManager.js';
import type { Run } from '../src/types.js';

function newMgr(): RM {
  return new RunManager();
}

describe('执行器: 基本执行（AC-08）', () => {
  it('最小方案执行成功，节点状态与日志完整', async () => {
    const mgr = newMgr();
    const run = await runAndWait(mgr, minimalPlan('p1'));
    expect(run.status).toBe('SUCCESS');
    expect(run.nodeStates.s.status).toBe('SUCCESS');
    expect(run.nodeStates.t.status).toBe('SUCCESS');
    expect(run.nodeStates.e.status).toBe('SUCCESS');
    // 结构化日志：事件齐全，seq 递增
    const events = run.logs.map((l) => l.event);
    expect(events).toContain('start');
    expect(events).toContain('success');
    expect(run.logs.map((l) => l.seq)).toEqual(run.logs.map((_, i) => i + 1));
    expect(run.finishedAt).not.toBeNull();
  });
});

describe('执行器: 并行波次（AC-06）', () => {
  it('无依赖任务并行执行（总耗时接近单个任务而非串行累加）', async () => {
    const mgr = newMgr();
    const plan = makePlan('p', [
      node('s', 'start'),
      node('a', 'task', { name: 'A', duration: 400 }),
      node('b', 'task', { name: 'B', duration: 400 }),
      node('e', 'end'),
    ], [edge('e1', 's', 'a'), edge('e2', 's', 'b'), edge('e3', 'a', 'e'), edge('e4', 'b', 'e')]);
    const started = Date.now();
    const run = await runAndWait(mgr, plan);
    const elapsed = Date.now() - started;
    expect(run.status).toBe('SUCCESS');
    // 串行需 ≥800ms，并行应显著低于该值
    expect(elapsed).toBeLessThan(700);
  });

  it('并发上限生效（maxConcurrency=1 时退化为串行）', async () => {
    const mgr = newMgr();
    const plan = makePlan('p', [
      node('s', 'start'),
      node('a', 'task', { name: 'A', duration: 150 }),
      node('b', 'task', { name: 'B', duration: 150 }),
      node('e', 'end'),
    ], [edge('e1', 's', 'a'), edge('e2', 's', 'b'), edge('e3', 'a', 'e'), edge('e4', 'b', 'e')],
    { maxConcurrency: 1 });
    const started = Date.now();
    const run = await runAndWait(mgr, plan);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(run.status).toBe('SUCCESS');
  });
});

describe('执行器: 条件路由（AC-06）', () => {
  function conditionPlan(expression: string): ReturnType<typeof makePlan> {
    return makePlan('p', [
      node('s', 'start'),
      node('t', 'task', { name: '比对密码哈希', duration: 10, output: 'passed' }),
      node('c', 'condition', { name: '认证是否通过', expression }),
      node('ok', 'task', { name: '记录登录日志', duration: 10 }),
      node('bad', 'task', { name: '返回错误提示', duration: 10 }),
      node('e', 'end'),
    ], [
      edge('e1', 's', 't'),
      edge('e2', 't', 'c'),
      edge('e3', 'c', 'ok', 'true'),
      edge('e4', 'c', 'bad', 'false'),
      edge('e5', 'ok', 'e'),
      edge('e6', 'bad', 'e'),
    ]);
  }

  it('表达式为 true → true 分支执行、false 分支 SKIPPED', async () => {
    const mgr = newMgr();
    const run = await runAndWait(mgr, conditionPlan('passed == true'));
    expect(run.status).toBe('SUCCESS');
    expect(run.nodeStates.ok.status).toBe('SUCCESS');
    expect(run.nodeStates.bad.status).toBe('SKIPPED');
    expect(run.logs.some((l) => l.nodeId === 'c' && l.message.includes('true'))).toBe(true);
  });

  it('表达式为 false → false 分支执行、true 分支 SKIPPED', async () => {
    const mgr = newMgr();
    const run = await runAndWait(mgr, conditionPlan('passed == false'));
    expect(run.nodeStates.bad.status).toBe('SUCCESS');
    expect(run.nodeStates.ok.status).toBe('SKIPPED');
  });

  it('output 变量成功后写入上下文供表达式求值', async () => {
    const mgr = newMgr();
    const run = await runAndWait(mgr, conditionPlan('passed == true'));
    expect(run.nodeStates.t.output).toEqual({ passed: true });
  });
});

describe('执行器: 失败重试（AC-07）', () => {
  it('failRate=1、retry=2：共 3 次尝试后 FAILED，下游 SKIPPED', async () => {
    const mgr = newMgr();
    const plan = makePlan('p', [
      node('s', 'start'),
      node('t', 'task', { name: '总是失败', duration: 10, retry: 2, failRate: 1 }),
      node('u', 'task', { name: '下游', duration: 10 }),
      node('e', 'end'),
    ], [edge('e1', 's', 't'), edge('e2', 't', 'u'), edge('e3', 'u', 'e')], {});
    const run = await runAndWait(mgr, plan);
    expect(run.status).toBe('FAILED');
    expect(run.nodeStates.t.status).toBe('FAILED');
    expect(run.nodeStates.t.attempt).toBe(3);
    expect(run.nodeStates.u.status).toBe('SKIPPED');
    expect(run.logs.filter((l) => l.event === 'retry')).toHaveLength(2);
  });

  it('重试后成功：attempt 记录与 message 正确', async () => {
    // rng 序列：第 1 次命中失败（<0.5），之后成功。直接构造 executor 以注入 rng
    let call = 0;
    const plan = makePlan('p', [
      node('s', 'start'),
      node('t', 'task', { name: '抖动任务', duration: 10, retry: 2, failRate: 0.5 }),
      node('e', 'end'),
    ], [edge('e1', 's', 't'), edge('e2', 't', 'e')]);
    const { PlanExecutor } = await import('../src/engine/executor.js');
    const now = new Date().toISOString();
    const run: Run = {
      id: 'run_test', planId: 'p', planName: 'p', status: 'VALIDATING',
      startedAt: now, finishedAt: null,
      nodeStates: { s: { status: 'PENDING' }, t: { status: 'PENDING' }, e: { status: 'PENDING' } },
      logs: [], error: null,
    };
    const executor = new PlanExecutor(plan, run, {
      rng: () => (call++ === 0 ? 0.1 : 0.9),
    });
    executor.start();
    // 时序：首次执行 10ms → 失败 → 退避 500ms → 第二次执行 10ms，共约 520ms
    await sleep(700);
    expect(run.status).toBe('SUCCESS');
    expect(run.nodeStates.t.attempt).toBe(2);
    expect(run.nodeStates.t.message).toBe('第 2 次尝试成功');
  });
});

describe('执行器: fail-fast 与 continueOnError（AC-07）', () => {
  function joinPlan(continueOnError: boolean): ReturnType<typeof makePlan> {
    return makePlan('p', [
      node('s', 'start'),
      node('a', 'task', { name: '失败分支', duration: 10, failRate: 1 }),
      node('b', 'task', { name: '成功分支', duration: 60 }),
      node('j', 'task', { name: '汇聚', duration: 10 }),
      node('e', 'end'),
    ], [
      edge('e1', 's', 'a'), edge('e2', 's', 'b'), edge('e3', 'a', 'j'), edge('e4', 'b', 'j'), edge('e5', 'j', 'e'),
    ], { continueOnError });
  }

  it('默认 fail-fast：汇聚节点 SKIPPED 并向下传播', async () => {
    const mgr = newMgr();
    const run = await runAndWait(mgr, joinPlan(false));
    expect(run.status).toBe('FAILED');
    expect(run.nodeStates.a.status).toBe('FAILED');
    expect(run.nodeStates.j.status).toBe('SKIPPED');
    expect(run.nodeStates.e.status).toBe('SKIPPED');
  });

  it('continueOnError=true：忽略失败继续执行', async () => {
    const mgr = newMgr();
    const run = await runAndWait(mgr, joinPlan(true));
    expect(run.status).toBe('FAILED');
    expect(run.nodeStates.j.status).toBe('SUCCESS');
    expect(run.nodeStates.e.status).toBe('SUCCESS');
  });
});

describe('执行器: 取消（规格 4.2.3 第 7 条）', () => {
  it('停止后未定态节点全部 CANCELED，运行 CANCELED', async () => {
    const mgr = newMgr();
    const plan = makePlan('p', [
      node('s', 'start'),
      node('a', 'task', { name: '长任务', duration: 2000 }),
      node('b', 'task', { name: '后继', duration: 10 }),
      node('e', 'end'),
    ], [edge('e1', 's', 'a'), edge('e2', 'a', 'b'), edge('e3', 'b', 'e')]);
    const runId = mgr.start(plan);
    await sleep(100); // 让 a 进入 RUNNING
    const run = mgr.cancel(runId);
    expect(run.status).toBe('CANCELED');
    expect(run.nodeStates.a.status).toBe('CANCELED');
    expect(run.nodeStates.b.status).toBe('CANCELED');
    expect(run.nodeStates.e.status).toBe('CANCELED');
    expect(run.error).toBe('用户手动停止');
    // cancel 幂等
    expect(mgr.cancel(runId).status).toBe('CANCELED');
  });

  it('同方案执行中重复执行 → 40901', async () => {
    const mgr = newMgr();
    const plan = makePlan('p', [
      node('s', 'start'),
      node('a', 'task', { name: '长任务', duration: 500 }),
      node('e', 'end'),
    ], [edge('e1', 's', 'a'), edge('e2', 'a', 'e')]);
    mgr.start(plan);
    expect(() => mgr.start(plan)).toThrowError(/正在执行中/);
    try {
      mgr.start(plan);
    } catch (err) {
      expect((err as { code?: number }).code).toBe(40901);
    }
  });
});

describe('执行器: 校验前置（NFR-04 / AC-05）', () => {
  it('含环方案拒绝执行（40002，定位到环上节点）', () => {
    const mgr = newMgr();
    const plan = makePlan('p', [
      node('s', 'start'),
      node('a', 'task', { name: 'A' }),
      node('b', 'task', { name: 'B' }),
      node('e', 'end'),
    ], [edge('e1', 's', 'a'), edge('e2', 'a', 'b'), edge('e3', 'b', 'a'), edge('e4', 'a', 'e')]);
    try {
      mgr.start(plan);
      expect.unreachable('应当拒绝执行');
    } catch (err) {
      const e = err as { code?: number; details?: Array<{ rule: string; nodeId?: string }> };
      expect(e.code).toBe(40002);
      expect(e.details?.some((d) => d.rule === 'R2' && d.nodeId)).toBe(true);
    }
  });
});
