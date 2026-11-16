/**
 * M1 - 规格文本清洗与格式识别（规格 4.2.1 处理流程第 1~2 步）。
 * 清洗：去除空行、统一全半角、规范化缩进；
 * 结构识别：Markdown 标题（#~####）或中文编号（"一、"、"1."、"1.1"）。
 */

export interface RawLine {
  /** 行文本（trim 后） */
  text: string;
  /** 缩进宽度（Tab 按 2 空格计） */
  indent: number;
}

/** 全角 ASCII 区字符 → 半角，全角空格 → 半角空格（规格：统一全半角） */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 去除空行并规范化缩进 */
export function splitLines(text: string): RawLine[] {
  return text
    .split('\n')
    .map((raw) => raw.replace(/\s+$/, ''))
    .filter((raw) => raw.trim().length > 0)
    .map((raw) => {
      const leading = raw.match(/^[ \t]*/)?.[0] ?? '';
      const indent = leading.replace(/\t/g, '  ').length;
      return { text: raw.trim(), indent };
    });
}

export type DetectedFormat = 'markdown' | 'numbered';

const NUMBERED_RE =
  /^(?:([0-9]+(?:\.[0-9]+)*)|([一二三四五六七八九十百]+))(?:\s*[、.．:：]\s*|\s+)(.+)$/;
const PAREN_CN_RE = /^\(([一二三四五六七八九十百]+)\)\s*(.+)$/;

/** 自动识别结构格式：Markdown 标题优先，其次中文编号，纯文本行按 Markdown 平铺条目处理 */
export function detectFormat(lines: RawLine[]): DetectedFormat | null {
  if (lines.length === 0) return null;
  if (lines.some((l) => /^#{1,6}\s+\S/.test(l.text))) return 'markdown';
  if (lines.some((l) => NUMBERED_RE.test(l.text) || PAREN_CN_RE.test(l.text))) return 'numbered';
  if (lines.some((l) => /^[-*•·]\s+\S/.test(l.text))) return 'markdown';
  return 'markdown';
}

export function isNumberedLine(text: string): boolean {
  return NUMBERED_RE.test(text) || PAREN_CN_RE.test(text);
}

/** 中文数字 → 阿拉伯数字（支持到 99） */
export function cnToNumber(cn: string): number | null {
  const digit: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (cn === '十') return 10;
  if (cn === '百') return 100;
  const m = cn.match(/^(?:(一|二|三|四|五|六|七|八|九))?十(?:(一|二|三|四|五|六|七|八|九))?$/);
  if (m) {
    const tens = m[1] ? digit[m[1]] : 1;
    const ones = m[2] ? digit[m[2]] : 0;
    return tens * 10 + ones;
  }
  if (cn.length === 1 && digit[cn]) return digit[cn];
  return null;
}

export { NUMBERED_RE, PAREN_CN_RE };
