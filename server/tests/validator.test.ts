/**
 * 方案校验器单元测试（规格 4.2.2 R1~R8 + 8.2 校验器测试点 + AC-05）。
 */
import { describe, expect, it } from 'vitest';
import { validate } from '../src/engine/validator.js';
import { edge, makePlan, minimalPlan, node } from './helpers.js';
import loginPlan from '../examples/login-plan.json';

const rules = (plan: Parameters<typeof validate>[0]) => validate(plan).details.map((d) => d.rule);

describe('校验器: 合法方案', () => {
  it('规格 5.2 示例方案通过', () => {
    const result = validate(loginPlan as unknown as Parameters<typeof validate>[0]);
    expect(result.ok).toBe(true);
    expect(result.details).toEqual([]);
  });

  it('最小方案通过', () => {
    expect(validate(minimalPlan('p1')).ok).toBe(true);
  });
});

describe('校验器: R1 唯一入口出口', () => {
  it('两个 start 被拒绝', () => {
    const plan = makePlan('p', [
      node('s1', 'start'), node('s2', 'start'), node('t', 'task', { name: 'A' }), node('e', 'end'),
    ], [edge('e1', 's1', 't'), edge('e2', 's2', 't'), edge('e3', 't', 'e')]);
    expect(rules(plan)).toContain('R1');
  });

  it('缺少 end 被拒绝', () => {
    const plan = makePlan('p', [node('s', 'start'), node('t', 'task', { name: 'A' })], [edge('e1', 's', 't')]);
    expect(rules(plan)).toContain('R1');
  });

  it('start 无出边被拒绝', () => {
    const plan = makePlan('p', [
      node('s', 'start'), node('t', 'task', { name: 'A' }), node('e', 'end'),
    ], [edge('e3', 't', 'e')]);
    expect(rules(plan)).toContain('R1');
  });

  it('start 直接 fan-out 两条出边合法（5.2 示例/附录 A 并行模式）', () => {
    const plan = makePlan('p', [
      node('s', 'start'),
      node('a', 'task', { name: 'A' }),
      node('b', 'task', { name: 'B' }),
      node('e', 'end'),
    ], [edge('e1', 's', 'a'), edge('e2', 's', 'b'), edge('e3', 'a', 'e'), edge('e4', 'b', 'e')]);
    expect(validate(plan).ok).toBe(true);
  });

  it('end 带出边被拒绝', () => {
    const plan = makePlan('p', [
      node('s', 'start'), node('e', 'end'), node('t', 'task', { name: 'A' }),
    ], [edge('e1', 's', 'e'), edge('e2', 'e', 't')]);
    expect(rules(plan)).toContain('R1');
  });
});

describe('校验器: R2 环检测（AC-05）', () => {
  it('检测环并报告环上节点序列', () => {
    const plan = makePlan('p', [
      node('s', 'start'), node('a', 'task', { name: 'A' }), node('b', 'task', { name: 'B' }),
      node('c', 'task', { name: 'C' }), node('e', 'end'),
    ], [
      edge('e1', 's', 'a'), edge('e2', 'a', 'b'), edge('e3', 'b', 'c'),
      edge('e4', 'c', 'a'), edge('e5', 'a', 'e'),
    ]);
    const result = validate(plan);
    expect(result.ok).toBe(false);
    const cycle = result.details.find((d) => d.rule === 'R2');
    expect(cycle).toBeDefined();
    expect(cycle?.message).toMatch(/存在环/);
    expect(cycle?.message).toMatch(/a.*b.*c|b.*c.*a|c.*a.*b/s);
    expect(cycle?.nodeId).toBeDefined();
  });
});

describe('校验器: R3 可达性', () => {
  it('孤立节点（start 不可达）被拒绝', () => {
    const plan = makePlan('p', [
      node('s', 'start'), node('t', 'task', { name: 'A' }), node('x', 'task', { name: '孤立' }), node('e', 'end'),
    ], [edge('e1', 's', 't'), edge('e2', 't', 'e')]);
    const detail = validate(plan).details.find((d) => d.rule === 'R3');
    expect(detail?.nodeId).toBe('x');
    expect(detail?.message).toMatch(/不可达/);
  });

  it('无法到达 end 的悬空节点被拒绝', () => {
    const plan = makePlan('p', [
      node('s', 'start'), node('t', 'task', { name: 'A' }), node('x', 'task', { name: '悬空' }), node('e', 'end'),
    ], [edge('e1', 's', 't'), edge('e2', 't', 'x'), edge('e3', 's', 'e')]);
    // t 与 x 都无法到达 end（x 是死端），两者均应被报告
    const r3 = validate(plan).details.filter((d) => d.rule === 'R3');
    expect(r3.map((d) => d.nodeId)).toEqual(expect.arrayContaining(['t', 'x']));
    expect(r3[0]?.message).toMatch(/无法到达 end/);
  });
});

describe('校验器: R4 条件分支', () => {
  const base = () => [
    node('s', 'start'),
    node('c', 'condition', { name: '条件', expression: 'passed == true' }),
    node('e', 'end'),
  ];

  it('condition 只有 1 条出边被拒绝', () => {
    const plan = makePlan('p', [...base(), node('t', 'task', { name: 'A' })], [
      edge('e1', 's', 'c'), edge('e2', 'c', 't', 'true'), edge('e3', 't', 'e'),
    ]);
    expect(rules(plan)).toContain('R4');
  });

  it('出边缺少 true/false 标注被拒绝', () => {
    const plan = makePlan('p', [...base(), node('a', 'task', { name: 'A' }), node('b', 'task', { name: 'B' })], [
      edge('e1', 's', 'c'), edge('e2', 'c', 'a'), edge('e3', 'c', 'b'), edge('e4', 'a', 'e'), edge('e5', 'b', 'e'),
    ]);
    expect(rules(plan)).toContain('R4');
  });

  it('两分支未汇聚于同一节点被拒绝（规格 6.2 示例错误）', () => {
    // 两个独立 end —— 但 end 数量又违反 R1；改用两个孤立汇聚点构造：
    const plan = makePlan('p', [
      node('s', 'start'),
      node('c', 'condition', { name: '条件', expression: 'passed == true' }),
      node('a', 'task', { name: 'A' }),
      node('b', 'task', { name: 'B' }),
      node('e', 'end'),
      node('x', 'task', { name: 'X' }),
    ], [
      edge('e1', 's', 'c'),
      edge('e2', 'c', 'a', 'true'),
      edge('e3', 'c', 'b', 'false'),
      edge('e4', 'a', 'e'),
      edge('e5', 'b', 'x'),
    ]);
    const result = validate(plan);
    const r4 = result.details.find((d) => d.rule === 'R4');
    expect(r4?.nodeId).toBe('c');
    expect(r4?.message).toMatch(/未汇聚/);
  });

  it('两分支汇聚于 end（入度 2）通过', () => {
    const plan = makePlan('p', [...base(), node('a', 'task', { name: 'A' }), node('b', 'task', { name: 'B' })], [
      edge('e1', 's', 'c'), edge('e2', 'c', 'a', 'true'), edge('e3', 'c', 'b', 'false'),
      edge('e4', 'a', 'e'), edge('e5', 'b', 'e'),
    ]);
    expect(validate(plan).ok).toBe(true);
  });
});

describe('校验器: R5/R8 边合法性', () => {
  it('自环被拒绝', () => {
    const plan = makePlan('p', [
      node('s', 'start'), node('t', 'task', { name: 'A' }), node('e', 'end'),
    ], [edge('e1', 's', 't'), edge('e2', 't', 't'), edge('e3', 't', 'e')]);
    expect(rules(plan)).toContain('R5');
  });

  it('重复边被拒绝', () => {
    const plan = makePlan('p', [
      node('s', 'start'), node('t', 'task', { name: 'A' }), node('e', 'end'),
    ], [edge('e1', 's', 't'), edge('e2', 's', 't'), edge('e3', 't', 'e')]);
    expect(rules(plan)).toContain('R5');
  });

  it('边指向不存在的节点被拒绝（R8）', () => {
    const plan = makePlan('p', [
      node('s', 'start'), node('t', 'task', { name: 'A' }), node('e', 'end'),
    ], [edge('e1', 's', 't'), edge('e2', 't', 'ghost')]);
    expect(rules(plan)).toContain('R8');
  });
});

describe('校验器: R6 属性合法', () => {
  it('duration 越界 / retry 越界 / failRate 越界', () => {
    const plan = makePlan('p', [
      node('s', 'start'),
      node('t', 'task', { name: 'A', duration: 70000, retry: 4, failRate: 2 }),
      node('e', 'end'),
    ], [edge('e1', 's', 't'), edge('e2', 't', 'e')]);
    const msgs = validate(plan).details.filter((d) => d.rule === 'R6').map((d) => d.message);
    expect(msgs.some((m) => m.includes('duration'))).toBe(true);
    expect(msgs.some((m) => m.includes('retry'))).toBe(true);
    expect(msgs.some((m) => m.includes('failRate'))).toBe(true);
  });

  it('边界值 0 / 60000 合法', () => {
    const plan = makePlan('p', [
      node('s', 'start'),
      node('t', 'task', { name: 'A', duration: 60000, retry: 0, failRate: 0 }),
      node('d', 'delay', { wait: 0 }),
      node('e', 'end'),
    ], [edge('e1', 's', 't'), edge('e2', 't', 'd'), edge('e3', 'd', 'e')]);
    expect(validate(plan).ok).toBe(true);
  });

  it('task 缺少 name / output 非法变量名被拒绝', () => {
    const plan = makePlan('p', [
      node('s', 'start'),
      node('t', 'task', { name: '', output: 'not a var' }),
      node('e', 'end'),
    ], [edge('e1', 's', 't'), edge('e2', 't', 'e')]);
    const msgs = validate(plan).details.filter((d) => d.rule === 'R6').map((d) => d.message);
    expect(msgs.some((m) => m.includes('name'))).toBe(true);
    expect(msgs.some((m) => m.includes('output'))).toBe(true);
  });

  it('condition 表达式语法非法被拒绝', () => {
    const plan = makePlan('p', [
      node('s', 'start'),
      node('c', 'condition', { name: 'C', expression: 'a === 1' }),
      node('a', 'task', { name: 'A' }),
      node('b', 'task', { name: 'B' }),
      node('e', 'end'),
    ], [
      edge('e1', 's', 'c'), edge('e2', 'c', 'a', 'true'), edge('e3', 'c', 'b', 'false'),
      edge('e4', 'a', 'e'), edge('e5', 'b', 'e'),
    ]);
    const r6 = validate(plan).details.find((d) => d.rule === 'R6');
    expect(r6?.message).toMatch(/expression 非法/);
  });
});

describe('校验器: R7 ID 唯一', () => {
  it('节点/边 ID 重复被拒绝', () => {
    const plan = makePlan('p', [
      node('s', 'start'), node('s', 'task', { name: 'A' }), node('e', 'end'),
    ], [edge('e1', 's', 'e'), edge('e1', 's', 'e')]);
    const msgs = validate(plan).details.filter((d) => d.rule === 'R7').map((d) => d.message);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });
});
