/**
 * M1 - 任务分解主流程（规格 4.2.1）：
 * 清洗 → 结构识别 → 任务树 → 关键词映射 → 依赖推断 → TaskSpec（5.5 节契约）。
 *
 * 依赖推断模型（与附录 A 示例严格对齐）：
 *  - 维护"执行前沿"（当前波次的尾任务集合），条目默认串行挂接到前沿；
 *  - 命中并行规则的同级组 → 组内条目共同挂接组前前沿（fan-out），组尾收敛为下一前沿；
 *  - condition 依赖前置任务，其后按 (通过时)/(未通过时) 绑定 true/false 分支；
 *  - 分支条目串行链接于本分支尾任务；分支后首个无后缀条目 = 汇聚点（依赖全部分支尾）；
 *  - end 条目收敛全部分支尾任务。
 */
import { ERR } from '../../errors.js';
import type { TaskSpec, TaskSpecTask } from '../../types.js';
import { buildTree, collectLeaves } from './parse.js';
import {
  analyzeLeaf,
  DEFAULT_CONDITION_EXPRESSION,
  DEFAULT_OUTPUT_VARIABLE,
  type LeafAnalysis,
} from './rules.js';
import { detectFormat, normalizeText, splitLines } from './normalize.js';

export interface DecomposeOptions {
  /** 来源名称/文件名（写入 TaskSpec.source），缺省取规格首个标题 */
  source?: string;
  /** 'auto' 自动识别（默认） */
  format?: 'auto' | 'markdown' | 'numbered';
}

export function decompose(specText: string, options: DecomposeOptions = {}): TaskSpec {
  const lines = splitLines(normalizeText(specText ?? ''));
  if (lines.length === 0) {
    throw ERR.DECOMPOSE_FAILED('规格文本为空');
  }

  const format =
    options.format && options.format !== 'auto' ? options.format : detectFormat(lines);
  if (!format) {
    throw ERR.DECOMPOSE_FAILED('无法识别规格结构：请使用 Markdown 标题或中文编号列表');
  }

  const tree = buildTree(lines, format);
  const leaves = collectLeaves(tree);
  if (leaves.length === 0) {
    throw ERR.DECOMPOSE_FAILED('规格中未找到可分解的任务条目');
  }

  const analyses = leaves.map((leaf, i) => analyzeLeaf(leaf.text, i === leaves.length - 1));
  assignParallelGroups(leaves, analyses);
  bindConditionOutputs(analyses);
  const dependencies = inferDependencies(leaves, analyses);

  const tasks: TaskSpecTask[] = leaves.map((leaf, i) => {
    const a = analyses[i];
    const task: TaskSpecTask = {
      key: leaf.key,
      name: a.name,
      type: a.type,
      dependsOn: dependencies[i] ?? [],
      parallelGroup: a.parallelGroup ?? null,
    };
    if (a.branch) task.branch = a.branch;
    if (a.type === 'condition') task.expression = a.expression ?? DEFAULT_CONDITION_EXPRESSION;
    if (a.output) task.output = a.output;
    if (a.type === 'delay' && a.wait != null) task.wait = a.wait;
    return task;
  });

  return {
    source: options.source?.trim() || guessSource(tree) || '未命名规格',
    detectedFormat: format,
    tasks,
  };
}

/** 同级叶子条目中任一命中并行规则 → 整组同号（该条目与其同级条目标记为并行组） */
function assignParallelGroups(leaves: NonNullable<ReturnType<typeof collectLeaves>>, analyses: LeafAnalysis[]): void {
  let groupSeq = 0;
  const byParent = new Map<object, number[]>();
  leaves.forEach((leaf, i) => {
    const parent = leaf.parent ?? leaves;
    const bucket = byParent.get(parent) ?? [];
    bucket.push(i);
    byParent.set(parent, bucket);
  });
  for (const indexes of byParent.values()) {
    if (indexes.some((i) => analyses[i].parallel)) {
      groupSeq += 1;
      for (const i of indexes) analyses[i].parallelGroup = groupSeq;
    }
  }
}

/** condition 的表达式变量由最近前置任务提供：前置 task 注入 output = "passed"（附录 A） */
function bindConditionOutputs(analyses: LeafAnalysis[]): void {
  analyses.forEach((a, i) => {
    if (a.type !== 'condition') return;
    a.expression = DEFAULT_CONDITION_EXPRESSION;
    for (let j = i - 1; j >= 0; j--) {
      if (analyses[j].type === 'task') {
        analyses[j].output = analyses[j].output ?? DEFAULT_OUTPUT_VARIABLE;
        break;
      }
    }
  });
}

/**
 * 依赖推断（前沿驱动，见文件头说明）。
 * @returns 与 leaves 等长的 dependsOn 数组
 */
function inferDependencies(
  leaves: NonNullable<ReturnType<typeof collectLeaves>>,
  analyses: LeafAnalysis[],
): string[][] {
  const result: string[][] = leaves.map(() => []);
  let frontier: string[] = []; // 当前串行前沿（波次尾任务）
  let groupBase: string[] | null = null; // 并行组共同挂接点
  let groupMembers: string[] = [];
  const branchTails = new Map<'true' | 'false', string>(); // 各分支当前尾任务
  let activeCondition: string | null = null;
  let lastBranch: 'true' | 'false' | null = null; // 供同段落无后缀条目继承
  let lastParent: object | null = null;

  const flushGroup = (): void => {
    if (groupBase !== null) {
      frontier = [...groupMembers];
      groupBase = null;
      groupMembers = [];
    }
  };
  const unique = (keys: string[]): string[] => [...new Set(keys)].filter((k) => k !== '');

  leaves.forEach((leaf, i) => {
    const key = leaf.key;
    const a = analyses[i];
    const prevParent = lastParent;

    // 分支继承：紧随分支条目、同段落、无后缀的 task/delay 继承分支
    //（附录 A 中 3.3 继承 3.2 的 true；end/condition 不继承）
    if (
      !a.branch &&
      lastBranch &&
      activeCondition &&
      leaf.parent === prevParent &&
      (a.type === 'task' || a.type === 'delay')
    ) {
      a.branch = lastBranch;
    }

    let deps: string[];

    if (a.type === 'end') {
      // 收敛：优先全部分支尾任务，否则当前前沿
      flushGroup();
      deps = branchTails.size > 0 ? [...branchTails.values()] : [...frontier];
      branchTails.clear();
      activeCondition = null;
      lastBranch = null;
      frontier = [key];
    } else if (a.branch && activeCondition) {
      // 分支绑定条目：挂接本分支尾任务（首条挂接条件本身）
      flushGroup();
      deps = [branchTails.get(a.branch) ?? activeCondition];
      branchTails.set(a.branch, key);
      lastBranch = a.branch;
    } else if (branchTails.size > 0) {
      // 分支后的首个未继承分支的条目：汇聚点，依赖全部分支尾任务
      flushGroup();
      deps = [...branchTails.values()];
      branchTails.clear();
      activeCondition = null;
      lastBranch = null;
      if (a.parallelGroup != null) {
        groupBase = deps;
        groupMembers = [key];
        deps = groupBase;
      } else {
        frontier = [key];
      }
    } else if (a.parallelGroup != null) {
      // 并行组：组内条目共同挂接组前前沿（fan-out）
      if (groupBase === null) {
        groupBase = [...frontier];
        groupMembers = [];
      }
      deps = groupBase;
      groupMembers.push(key);
    } else {
      // 普通串行条目：挂接当前前沿
      flushGroup();
      deps = [...frontier];
      frontier = [key];
    }

    if (a.type === 'condition') {
      activeCondition = key;
      branchTails.clear();
      frontier = [key];
      lastBranch = null;
    }

    result[i] = unique(deps);
    lastParent = leaf.parent ?? null;
  });

  return result;
}

/** 推断来源名：首个标题文本，否则首行文本（截断 50 字符） */
function guessSource(tree: ReturnType<typeof buildTree>): string {
  const first = tree.children[0];
  const text = first?.text ?? '';
  return text.length > 50 ? text.slice(0, 50) : text;
}
