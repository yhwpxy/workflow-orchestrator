/**
 * M1 - 结构解析：按标题/编号层级构建任务树（规格 4.2.1 处理流程第 2 步）。
 * 列表项与无子级的条目作为叶子任务；有子级的条目仅作分组（依赖经"波次链"推断）。
 */
import type { DetectedFormat, RawLine } from './normalize.js';
import { NUMBERED_RE, PAREN_CN_RE, cnToNumber } from './normalize.js';

export interface ParsedNode {
  /** 层级：标题 1~6；条目 = 标题层级 + 0.5 + 缩进深度（保证条目挂在标题下且同级条目同层） */
  level: number;
  kind: 'root' | 'heading' | 'item';
  /** 原始条目文本（未经关键词规则处理） */
  text: string;
  /** 条目自带编号（如 "1"、"1.1"），无则 null */
  ownNumber: string | null;
  key: string;
  children: ParsedNode[];
  parent: ParsedNode | null;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BULLET_RE = /^[-*•·]\s+(.+)$/;
/** 条目自带的 "1." / "1、" 前缀（仅剥离，不参与 key 生成） */
const ITEM_NUMBER_PREFIX_RE = /^\d+(?:\.\d+)*[、.．)]\s*/;
/** 标题自带编号："## 1 输入校验" → "1" */
const LEADING_NUMBER_RE = /^(\d+(?:\.\d+)*)(?:[、.．:：]\s*|\s+)/;

function extractLeadingNumber(text: string): string | null {
  return LEADING_NUMBER_RE.test(text) ? (LEADING_NUMBER_RE.exec(text)?.[1] ?? null) : null;
}

/** 构建任务树（栈式层级归并），并对编号条目/标题计算 key */
export function buildTree(lines: RawLine[], format: DetectedFormat): ParsedNode {
  const root: ParsedNode = { level: 0, kind: 'root', text: '', ownNumber: null, key: '', children: [], parent: null };
  const stack: ParsedNode[] = [root];
  let lastHeadingLevel = 0;
  let lastNumberedLevel = 0;
  // 是否存在中文编号（"一、"）——决定混编文档的层级规则
  const hasCnNumber = lines.some(
    (l) => /^[一二三四五六七八九十百]+\s*[、.．:：]/.test(l.text) || PAREN_CN_RE.test(l.text),
  );

  for (const line of lines) {
    let node: ParsedNode;

    if (format === 'markdown') {
      const heading = HEADING_RE.exec(line.text);
      if (heading) {
        const level = heading[1].length;
        const text = heading[2].trim();
        node = { level, kind: 'heading', text, ownNumber: extractLeadingNumber(text), key: '', children: [], parent: null };
        attach(stack, node, /* popItems */ true);
        lastHeadingLevel = level;
        stack.push(node);
        continue;
      }
      const bullet = BULLET_RE.exec(line.text);
      const text = (bullet ? bullet[1] : line.text).replace(ITEM_NUMBER_PREFIX_RE, '').trim();
      node = {
        level: lastHeadingLevel + 0.5 + line.indent / 2,
        kind: 'item',
        text,
        ownNumber: null,
        key: '',
        children: [],
        parent: null,
      };
      attach(stack, node, false);
      stack.push(node);
      continue;
    }

    // numbered 模式：混编文档（含"一、"）中，中文编号为一级、阿拉伯编号按段数下探；
    // 纯阿拉伯数字文档按编号段数分层
    const numbered = NUMBERED_RE.exec(line.text);
    const paren = PAREN_CN_RE.exec(line.text);
    if (numbered) {
      const arabic = numbered[1];
      const chinese = numbered[2];
      let level: number;
      let ownNumber: string;
      if (arabic) {
        level = hasCnNumber ? 1 + arabic.split('.').length : arabic.split('.').length;
        ownNumber = arabic;
      } else {
        level = 1;
        ownNumber = String(cnToNumber(chinese) ?? 0);
      }
      lastNumberedLevel = level;
      node = { level, kind: 'item', text: numbered[3].trim(), ownNumber, key: '', children: [], parent: null };
    } else if (paren) {
      // "（一）"形式：混编文档中视为二级，否则视为一级
      const level = hasCnNumber ? 2 : 1;
      lastNumberedLevel = level;
      node = {
        level,
        kind: 'item',
        text: paren[2].trim(),
        ownNumber: String(cnToNumber(paren[1]) ?? 0),
        key: '',
        children: [],
        parent: null,
      };
    } else {
      // 编号文档中的列表项/普通行：挂在最近编号条目之下
      const bullet = BULLET_RE.exec(line.text);
      const text = (bullet ? bullet[1] : line.text).trim();
      node = {
        level: lastNumberedLevel + 1 + line.indent / 2,
        kind: 'item',
        text,
        ownNumber: null,
        key: '',
        children: [],
        parent: null,
      };
    }
    attach(stack, node, false);
    stack.push(node);
  }

  assignKeys(root, format);
  return root;
}

/** 入栈挂接：heading 前先弹出其上的条目（标题永远不作为条目的子节点），再按层级弹出同级 */
function attach(stack: ParsedNode[], node: ParsedNode, isHeading: boolean): void {
  if (isHeading) {
    while (stack.length > 1 && stack[stack.length - 1].kind === 'item') stack.pop();
  }
  while (stack.length > 1 && stack[stack.length - 1].level >= node.level) stack.pop();
  const parent = stack[stack.length - 1];
  node.parent = parent;
  parent.children.push(node);
}

/** 计算 key：numbered 用位置序号（避免"一、/1."混编冲突）；markdown 用路径 + 序号 */
function assignKeys(root: ParsedNode, format: DetectedFormat): void {
  if (format === 'numbered') {
    const walk = (node: ParsedNode, parentKey: string): void => {
      if (node.kind !== 'root') {
        const seq = node.parent ? node.parent.children.indexOf(node) + 1 : 1;
        node.key = parentKey ? `${parentKey}.${seq}` : String(seq);
      }
      for (const child of node.children) walk(child, node.kind === 'root' ? '' : node.key);
    };
    walk(root, '');
    return;
  }

  // markdown：标题贡献路径段；条目 key = 路径 + 兄弟序号。
  // 自带编号的标题（如 "## 1 输入校验"）使用绝对编号路径；
  // 文档首个无编号一级标题视为全文标题，不计入路径。
  const headings: ParsedNode[] = [];
  const collect = (n: ParsedNode): void => {
    if (n.kind === 'heading') headings.push(n);
    for (const c of n.children) collect(c);
  };
  collect(root);
  const first = root.children[0];
  const titleSuppressed =
    headings.length > 1 &&
    !!first &&
    first.kind === 'heading' &&
    first.level === 1 &&
    !first.ownNumber;

  const walk = (node: ParsedNode, path: string[], counters: number[]): void => {
    if (node.kind === 'root') {
      for (const child of node.children) walk(child, path, [...counters]);
      return;
    }
    if (node.kind === 'heading') {
      let nextPath: string[];
      if (node.ownNumber) {
        nextPath = [node.ownNumber];
      } else if (node.level === 1 && titleSuppressed && node.parent?.kind === 'root') {
        nextPath = path;
      } else {
        counters[node.level] = (counters[node.level] ?? 0) + 1;
        for (let l = node.level + 1; l < counters.length; l++) counters[l] = 0;
        nextPath = [...path, String(counters[node.level])];
      }
      for (const child of node.children) walk(child, nextPath, [...counters]);
      return;
    }
    // item
    const idx = node.parent
      ? node.parent.children.filter((c) => c.kind === 'item').indexOf(node) + 1
      : 1;
    node.key = [...path, String(idx)].join('.');
    for (const child of node.children) walk(child, [...path, String(idx)], [...counters]);
  };
  walk(root, [], []);
}

/** 深度优先收集叶子条目（文档顺序），叶子 = 无子级的节点 */
export function collectLeaves(root: ParsedNode): ParsedNode[] {
  const leaves: ParsedNode[] = [];
  const walk = (node: ParsedNode): void => {
    if (node.kind !== 'root' && node.children.length === 0) leaves.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return leaves;
}
