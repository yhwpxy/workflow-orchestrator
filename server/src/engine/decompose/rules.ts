/**
 * M1 - 关键词映射规则表（规格 4.2.1 第 3 步）。
 * 规则按数组注册、顺序生效，新增规则不改主流程（NFR-08 注册式扩展）。
 *
 * 匹配约定（文本已统一全半角）：
 *  - 分支后缀：(通过时)/(通过) → true 分支；(未通过时)/(未通过) → false 分支
 *  - 并行前缀：并行：/同时：/分别： 或句中包含 并行/同时/分别
 *  - 条件：判断：/如果/否则/是否（前缀优先剥离）
 *  - 延时：等待/延时/延迟（可从文本提取 "N秒/Nms"，默认 1000ms）
 *  - 结束：最后一个叶子条目包含 结束/输出/提交 → end
 */
import type { NodeType } from '../../types.js';

export interface LeafAnalysis {
  name: string;
  type: NodeType;
  parallel: boolean;
  /** 并行组号（由主流程按同级组分配） */
  parallelGroup?: number;
  branch?: 'true' | 'false';
  expression?: string;
  output?: string;
  wait?: number;
}

/** 条件表达式默认模板：变量由前置任务的 output 提供（见附录 A） */
export const DEFAULT_CONDITION_EXPRESSION = 'passed == true';
/** 条件前置任务默认注入的输出变量名 */
export const DEFAULT_OUTPUT_VARIABLE = 'passed';
/** delay 默认等待时长 */
export const DEFAULT_DELAY_WAIT = 1000;

const BRANCH_SUFFIX_RE = /\((未)?通过(时)?\)$/;
const PARALLEL_PREFIX_RE = /^(并行|同时|分别)\s*:?\s*/;
const PARALLEL_CONTAIN_RE = /(并行|同时|分别)/;
const CONDITION_PREFIX_RE = /^(判断|如果|否则|是否)\s*:?\s*/;
const CONDITION_CONTAIN_RE = /(判断|如果|否则|是否)/;
const DELAY_PREFIX_RE = /^(等待|延时|延迟)\s*:?\s*/;
const DELAY_CONTAIN_RE = /(等待|延时|延迟)/;
const DELAY_DURATION_RE = /(\d+(?:\.\d+)?)\s*(毫秒|ms|秒|s|m|分|分钟)?/i;
const END_CONTAIN_RE = /(结束|输出|提交)/;

/** 对单个叶子条目做关键词分析（纯函数，便于单测） */
export function analyzeLeaf(raw: string, isLastLeaf: boolean): LeafAnalysis {
  let text = raw.trim();
  const result: LeafAnalysis = { name: raw.trim(), type: 'task', parallel: false };

  // 1. 分支后缀（先剥离，避免干扰其他规则）
  const branchMatch = BRANCH_SUFFIX_RE.exec(text);
  if (branchMatch) {
    result.branch = branchMatch[1] ? 'false' : 'true';
    text = text.slice(0, branchMatch.index).trim();
  }

  // 2. 并行
  const parallelPrefix = PARALLEL_PREFIX_RE.exec(text);
  if (parallelPrefix) {
    result.parallel = true;
    text = text.slice(parallelPrefix[0].length).trim();
  } else if (PARALLEL_CONTAIN_RE.test(text)) {
    result.parallel = true;
  }

  // 3. 条件（前缀优先剥离，避免"判断：xxx是否…"重复命中）
  const conditionPrefix = CONDITION_PREFIX_RE.exec(text);
  if (conditionPrefix) {
    result.type = 'condition';
    text = text.slice(conditionPrefix[0].length).trim();
  } else if (CONDITION_CONTAIN_RE.test(text)) {
    result.type = 'condition';
  }

  // 4. 延时
  if (result.type !== 'condition') {
    const delayPrefix = DELAY_PREFIX_RE.exec(text);
    if (delayPrefix) {
      result.type = 'delay';
      text = text.slice(delayPrefix[0].length).trim();
    } else if (DELAY_CONTAIN_RE.test(text)) {
      result.type = 'delay';
    }
    if (result.type === 'delay') {
      result.wait = extractWait(text) ?? DEFAULT_DELAY_WAIT;
    }
  }

  // 5. 结束（仅末位条目命中，降低误判）
  if (result.type === 'task' && isLastLeaf && END_CONTAIN_RE.test(text)) {
    result.type = 'end';
  }

  result.name = text.length > 0 ? text : raw.trim();
  return result;
}

/** 从延时条目文本提取等待时长（"3秒"→3000ms，"500ms"→500ms） */
function extractWait(text: string): number | null {
  const m = DELAY_DURATION_RE.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = (m[2] ?? 'ms').toLowerCase();
  const ms = unit === '秒' || unit === 's' ? value * 1000 : unit === '分' || unit === '分钟' || unit === 'm' ? value * 60_000 : value;
  return Math.min(60_000, Math.round(ms));
}
