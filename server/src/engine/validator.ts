/**
 * M3 - 方案校验器（规格 4.2.2，服务端权威校验）。
 *
 * R1 唯一入口出口   恰 1 个 start（入度 0、出度 1）与恰 1 个 end（出度 0、入度 ≥1）
 * R2 无环           DFS 三色标记检测，报告环上节点序列
 * R3 可达性         所有节点自 start 可达且能到达 end；报告孤立节点/悬空节点
 * R4 条件汇聚       condition 恰有 2 条出边（true/false 各一），两分支汇聚于同一入度>1 节点
 * R5 边合法性       无自环、无重复边
 * R6 属性合法       name/duration/wait/retry/failRate/expression 按类型约束
 * R7 ID 唯一        节点/边 ID 不重复
 * R8 结构一致       边两端节点均存在（防御数据损坏）
 *
 * 校验收集全部错误而非首错即停；details 可定位到节点（规格 6.2）。
 */
import type { Plan, PlanNode, ValidationDetail } from '../types.js';
import { validateExpression } from './expression/evaluator.js';

export interface ValidationResult {
  ok: boolean;
  details: ValidationDetail[];
}

const NODE_TYPES = new Set(['start', 'task', 'condition', 'delay', 'end']);
const NAME_MAX = 50;
const DURATION_MAX = 60_000;
const RETRY_MAX = 3;

export function validate(plan: Plan): ValidationResult {
  const details: ValidationDetail[] = [];
  const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
  const edges = Array.isArray(plan.edges) ? plan.edges : [];
  const nodeById = new Map<string, PlanNode>();

  // ---- R7 ID 唯一 + 未知类型 ----
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string') {
      details.push({ rule: 'R7', message: '存在缺少 id 的节点' });
      continue;
    }
    if (nodeById.has(node.id)) {
      details.push({ nodeId: node.id, rule: 'R7', message: `节点 ID 重复: ${node.id}` });
      continue;
    }
    nodeById.set(node.id, node);
    if (!NODE_TYPES.has(node.type)) {
      details.push({ nodeId: node.id, rule: 'R6', message: `未知节点类型: ${String(node.type)}` });
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (!edge || typeof edge.id !== 'string') {
      details.push({ rule: 'R7', message: '存在缺少 id 的边' });
      continue;
    }
    if (edgeIds.has(edge.id)) {
      details.push({ nodeId: edge.id, rule: 'R7', message: `边 ID 重复: ${edge.id}` });
      continue;
    }
    edgeIds.add(edge.id);
  }

  // ---- R8/R5 边两端存在、自环 ----
  const validEdges = edges.filter(
    (e) => e && typeof e.id === 'string' && typeof e.source === 'string' && typeof e.target === 'string',
  );
  for (const edge of validEdges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      details.push({
        nodeId: edge.id,
        rule: 'R8',
        message: `边 ${edge.id} 两端节点不存在 (${edge.source} → ${edge.target})`,
      });
    } else if (edge.source === edge.target) {
      details.push({ nodeId: edge.source, rule: 'R5', message: `节点 ${edge.source} 存在自环` });
    }
  }

  // 重复边（同 source+target）
  const pairSeen = new Set<string>();
  for (const edge of validEdges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    const pairKey = `${edge.source}->${edge.target}`;
    if (pairSeen.has(pairKey)) {
      details.push({
        nodeId: edge.source,
        rule: 'R5',
        message: `重复边: ${edge.source} → ${edge.target}`,
      });
    }
    pairSeen.add(pairKey);
  }

  // ---- 邻接表 / 度表 ----
  const outEdges = new Map<string, typeof validEdges>();
  const inEdges = new Map<string, typeof validEdges>();
  for (const node of nodeById.values()) {
    outEdges.set(node.id, []);
    inEdges.set(node.id, []);
  }
  for (const edge of validEdges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) continue;
    outEdges.get(edge.source)?.push(edge);
    inEdges.get(edge.target)?.push(edge);
  }

  // ---- R1 唯一入口出口 ----
  const starts = nodes.filter((n) => n?.type === 'start');
  const ends = nodes.filter((n) => n?.type === 'end');
  if (starts.length !== 1) {
    details.push({ rule: 'R1', message: `start 节点数量必须为 1，实际 ${starts.length}` });
  }
  if (ends.length !== 1) {
    details.push({ rule: 'R1', message: `end 节点数量必须为 1，实际 ${ends.length}` });
  }
  for (const start of starts) {
    if ((inEdges.get(start.id)?.length ?? 0) !== 0) {
      details.push({ nodeId: start.id, rule: 'R1', message: 'start 节点不允许有入边' });
    }
    // 注：规格 4.1.1 写明 start 出度=1，但 5.2 示例方案与附录 A 分解图均为
    // start 直接 fan-out 两条出边（并行），二者矛盾。以数据契约示例（5.2/附录 A）
    // 为准放宽为出度 ≥1，画布侧仍可按更严格交互约束实现（FR-06）。
    if ((outEdges.get(start.id)?.length ?? 0) < 1) {
      details.push({ nodeId: start.id, rule: 'R1', message: 'start 节点至少需要 1 条出边' });
    }
  }
  for (const end of ends) {
    if ((outEdges.get(end.id)?.length ?? 0) !== 0) {
      details.push({ nodeId: end.id, rule: 'R1', message: 'end 节点不允许有出边' });
    }
    if ((inEdges.get(end.id)?.length ?? 0) < 1) {
      details.push({ nodeId: end.id, rule: 'R1', message: 'end 节点至少需要 1 条入边' });
    }
  }

  // ---- R2 无环（DFS 三色标记：0 白 1 灰 2 黑） ----
  const color = new Map<string, number>();
  const onStack: string[] = [];
  let cycleReported = false;
  const dfs = (id: string): void => {
    color.set(id, 1);
    onStack.push(id);
    for (const edge of outEdges.get(id) ?? []) {
      const c = color.get(edge.target) ?? 0;
      if (c === 1) {
        if (!cycleReported) {
          const from = onStack.indexOf(edge.target);
          const cycle = [...onStack.slice(from === -1 ? 0 : from), edge.target];
          details.push({
            nodeId: edge.target,
            rule: 'R2',
            message: `存在环: ${cycle.join(' → ')}`,
          });
          cycleReported = true;
        }
      } else if (c === 0) {
        dfs(edge.target);
      }
    }
    onStack.pop();
    color.set(id, 2);
  };
  for (const id of nodeById.keys()) {
    if ((color.get(id) ?? 0) === 0) dfs(id);
  }

  // ---- R3 可达性（start/end 存在时才检查，避免级联误报） ----
  if (starts.length === 1 && ends.length === 1) {
    const forward = reachable(starts[0].id, (id) => (outEdges.get(id) ?? []).map((e) => e.target));
    const backward = reachable(ends[0].id, (id) => (inEdges.get(id) ?? []).map((e) => e.source));
    for (const node of nodeById.values()) {
      if (!forward.has(node.id)) {
        details.push({
          nodeId: node.id,
          rule: 'R3',
          message: `孤立节点: "${displayName(node)}" 从 start 不可达`,
        });
      } else if (!backward.has(node.id)) {
        details.push({
          nodeId: node.id,
          rule: 'R3',
          message: `悬空节点: "${displayName(node)}" 无法到达 end`,
        });
      }
    }
  }

  // ---- R4 条件分支 ----
  const inDegree = new Map<string, number>();
  for (const [id, list] of inEdges) inDegree.set(id, list.length);
  for (const node of nodeById.values()) {
    if (node.type !== 'condition') continue;
    const outs = outEdges.get(node.id) ?? [];
    if (outs.length !== 2) {
      details.push({
        nodeId: node.id,
        rule: 'R4',
        message: `条件分支必须恰有 2 条出边（true/false），实际 ${outs.length}`,
      });
      continue;
    }
    const labels = new Set(outs.map((e) => e.label));
    if (!labels.has('true') || !labels.has('false')) {
      details.push({
        nodeId: node.id,
        rule: 'R4',
        message: '条件分支出边必须分别标注 true 与 false',
      });
      continue;
    }
    if (outs[0].target === outs[1].target) {
      details.push({ nodeId: node.id, rule: 'R4', message: '条件分支两条出边不能指向同一节点' });
      continue;
    }
    // 两分支必须汇聚于同一 join 节点（分别沿两分支 BFS，公共可达且入度 > 1）
    const trueTarget = outs.find((e) => e.label === 'true')?.target ?? '';
    const falseTarget = outs.find((e) => e.label === 'false')?.target ?? '';
    const trueReach = reachable(trueTarget, (id) => (outEdges.get(id) ?? []).map((e) => e.target));
    const falseReach = reachable(falseTarget, (id) => (outEdges.get(id) ?? []).map((e) => e.target));
    let joinId: string | null = null;
    for (const id of trueReach) {
      if (falseReach.has(id) && (inDegree.get(id) ?? 0) > 1) {
        joinId = id;
        break;
      }
    }
    if (!joinId) {
      details.push({
        nodeId: node.id,
        rule: 'R4',
        message: '条件分支未汇聚于同一节点',
      });
    }
  }

  // ---- R6 属性合法 ----
  for (const node of nodeById.values()) {
    details.push(...validateProps(node));
  }

  return { ok: details.length === 0, details };
}

// ---------- 属性校验（R6） ----------

function validateProps(node: PlanNode): ValidationDetail[] {
  const details: ValidationDetail[] = [];
  const props = (node.props ?? {}) as Record<string, unknown>;
  const label = (msg: string): ValidationDetail => ({ nodeId: node.id, rule: 'R6', message: msg });

  if (!NODE_TYPES.has(node.type)) return details; // 类型错误已在前面报告

  if (typeof node.x !== 'number' || typeof node.y !== 'number') {
    details.push(label('节点缺少画布坐标 x/y'));
  }

  const checkName = (): void => {
    const name = props.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      details.push(label(`节点 "${displayName(node)}" 缺少 name 属性`));
    } else if (name.length > NAME_MAX) {
      details.push(label(`name 超过 ${NAME_MAX} 字符`));
    }
  };
  const checkNumber = (key: string, min: number, max: number, integer = false): void => {
    const v = props[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      details.push(label(`属性 ${key} 必须为数字`));
    } else if (integer && !Number.isInteger(v)) {
      details.push(label(`属性 ${key} 必须为整数`));
    } else if (v < min || v > max) {
      details.push(label(`属性 ${key} 超出范围 [${min}, ${max}]`));
    }
  };

  switch (node.type) {
    case 'task':
      checkName();
      if (props.duration !== undefined) checkNumber('duration', 0, DURATION_MAX);
      if (props.retry !== undefined) checkNumber('retry', 0, RETRY_MAX, true);
      if (props.failRate !== undefined) checkNumber('failRate', 0, 1);
      if (props.output !== undefined) {
        if (typeof props.output !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(props.output)) {
          details.push(label('output 必须为合法变量名（字母/下划线开头）'));
        }
      }
      break;
    case 'condition':
      checkName();
      if (typeof props.expression !== 'string' || props.expression.trim().length === 0) {
        details.push(label('条件分支缺少 expression'));
      } else {
        try {
          validateExpression(props.expression);
        } catch (err) {
          details.push(label(`expression 非法: ${(err as Error).message}`));
        }
      }
      break;
    case 'delay':
      checkNumber('wait', 0, DURATION_MAX);
      break;
    default:
      break; // start / end 无属性约束
  }
  return details;
}

function displayName(node: PlanNode): string {
  const name = (node.props as Record<string, unknown> | undefined)?.name;
  return typeof name === 'string' && name.length > 0 ? name : node.id;
}

/** BFS 可达集合 */
function reachable(from: string, next: (id: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined || seen.has(cur)) continue;
    seen.add(cur);
    for (const n of next(cur)) {
      if (!seen.has(n)) queue.push(n);
    }
  }
  return seen;
}
