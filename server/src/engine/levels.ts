/**
 * M3 - 拓扑分层（规格 4.2.3 第 3 条）：Kahn 算法求每个节点的波次 level。
 * level 越大越晚就绪；同层节点相互无依赖，具备并行性。
 * 环上节点无法获得 level（校验器已在执行前拒绝），此处兜底记为 0。
 */
import type { PlanEdge, PlanNode } from '../types.js';

export function computeLevels(nodes: PlanNode[], edges: PlanEdge[]): Map<string, number> {
  const levels = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const out = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    out.set(node.id, []);
  }
  for (const edge of edges) {
    if (!inDegree.has(edge.source) || !inDegree.has(edge.target)) continue;
    out.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      levels.set(id, 0);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    const curLevel = levels.get(cur) ?? 0;
    for (const next of out.get(cur) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) {
        levels.set(next, curLevel + 1);
        queue.push(next);
      }
    }
  }
  // 兜底：环上节点（理论不可达，校验器已拦截）
  for (const node of nodes) {
    if (!levels.has(node.id)) levels.set(node.id, 0);
  }
  return levels;
}
