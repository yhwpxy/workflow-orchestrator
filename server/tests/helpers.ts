/**
 * 测试公共工具：快速构建方案、运行至终态。
 */
import type { Plan, PlanEdge, PlanNode, Run, RunStatus } from '../src/types.js';
import { RunManager } from '../src/engine/runManager.js';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const TERMINAL: RunStatus[] = ['SUCCESS', 'FAILED', 'CANCELED'];

export function node(
  id: string,
  type: PlanNode['type'],
  props: PlanNode['props'] = {},
  x = 0,
  y = 0,
): PlanNode {
  return { id, type, x, y, props };
}

export function edge(id: string, source: string, target: string, label?: string): PlanEdge {
  return label === undefined ? { id, source, target } : { id, source, target, label };
}

export function makePlan(
  id: string,
  nodes: PlanNode[],
  edges: PlanEdge[],
  meta?: Plan['meta'],
): Plan {
  const now = '2026-11-10T10:00:00+08:00';
  return {
    id,
    name: `测试方案-${id}`,
    version: '1.0',
    ...(meta ? { meta } : {}),
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
  };
}

/** 最小合法方案：start → task → end */
export function minimalPlan(id: string, overrides: Partial<Plan> = {}): Plan {
  return {
    ...makePlan(
      id,
      [
        node('s', 'start'),
        node('t', 'task', { name: '任务', duration: 10 }),
        node('e', 'end'),
      ],
      [edge('e1', 's', 't'), edge('e2', 't', 'e')],
    ),
    ...overrides,
  };
}

/** 用 RunManager 运行方案并等待终态（executor 直接变更注册表中的 Run 对象） */
export async function runAndWait(
  mgr: RunManager,
  plan: Plan,
  timeoutMs = 8000,
): Promise<Run> {
  const runId = mgr.start(plan);
  const run = mgr.getRun(runId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !TERMINAL.includes(run.status)) {
    await sleep(15);
  }
  return run;
}
