/**
 * M3 - 受限表达式求值（规格 4.2.6，满足 NFR-10）。
 *
 * 文法（LL(1) 递归下降，白名单）：
 *   orExpr   := andExpr ( "||" andExpr )*
 *   andExpr  := cmpExpr ( "&&" cmpExpr )*
 *   cmpExpr  := unary ( ("=="|"!="|">"|"<"|">="|"<=") unary )?
 *   unary    := ( "!" | "-" ) unary | primary
 *   primary  := number | string | true | false | identifier | "(" orExpr ")"
 *
 * 仅支持：比较、逻辑、括号、上下文变量、数字/字符串字面量。
 * 禁止：函数调用、赋值、属性访问与任意 JS 执行。
 * 自研实现，不使用 eval/new Function。
 */

export type ExprValue = boolean | number | string;

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/** parse-only 模式的"任意值"哨兵：未知变量占位，跳过类型检查（语法校验期变量尚不存在） */
interface AnyMarker {
  readonly __anyMarker: true;
}
const ANY: AnyMarker = { __anyMarker: true };
type Value = ExprValue | AnyMarker;
const isAny = (v: Value): v is AnyMarker =>
  typeof v === 'object' && v !== null && (v as AnyMarker).__anyMarker === true;

type TokenType = 'number' | 'string' | 'ident' | 'op' | 'lparen' | 'rparen';
interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const TWO_CHAR_OPS = ['==', '!=', '>=', '<=', '&&', '||'];
const ONE_CHAR_OPS = ['>', '<', '!', '-'];
const KEYWORDS = new Set(['true', 'false']);

/** 词法分析 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(ch) || ch === '=') {
      // 单独的 "=" 属于赋值语法，白名单拒绝
      if (ch === '=') throw new ExpressionError(`位置 ${i}: 不支持赋值运算符 "="`);
      tokens.push({ type: 'op', value: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch, pos: i });
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^\d+(?:\.\d+)?/.exec(input.slice(i));
      if (!m) throw new ExpressionError(`位置 ${i}: 非法数字`);
      tokens.push({ type: 'number', value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = input.indexOf(ch, i + 1);
      if (end === -1) throw new ExpressionError(`位置 ${i}: 字符串未闭合`);
      tokens.push({ type: 'string', value: input.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    // 标识符：字母/下划线/中文
    const m = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/.exec(input.slice(i));
    if (!m) throw new ExpressionError(`位置 ${i}: 无法识别的字符 "${ch}"`);
    tokens.push({ type: 'ident', value: m[0], pos: i });
    i += m[0].length;
  }
  return tokens;
}

// ---- 递归下降解析器 ----

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly variables: Record<string, ExprValue>,
    /** parse-only 模式：不做变量解析（校验期变量尚不存在），未知标识符按 ANY 哨兵处理 */
    private readonly parseOnly = false,
  ) {}

  /** 入口：解析并求值整个表达式 */
  evaluate(): Value {
    if (this.tokens.length === 0) throw new ExpressionError('表达式为空');
    const value = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new ExpressionError(`位置 ${this.tokens[this.pos].pos}: 存在多余的内容`);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eatOp(...ops: string[]): string | null {
    const t = this.peek();
    if (t && t.type === 'op' && ops.includes(t.value)) {
      this.pos += 1;
      return t.value;
    }
    return null;
  }

  private parseOr(): Value {
    let left = this.parseAnd();
    while (this.eatOp('||')) {
      const right = this.parseAnd();
      left = this.requireBool(left, '||') || this.requireBool(right, '||');
    }
    return left;
  }

  private parseAnd(): Value {
    let left = this.parseCompare();
    while (this.eatOp('&&')) {
      const right = this.parseCompare();
      left = this.requireBool(left, '&&') && this.requireBool(right, '&&');
    }
    return left;
  }

  private parseCompare(): Value {
    const left = this.parseUnary();
    const op = this.eatOp('==', '!=', '>=', '<=', '>', '<');
    if (!op) return left;
    const right = this.parseUnary();
    return compare(left, right, op);
  }

  private parseUnary(): Value {
    if (this.eatOp('!')) {
      return !this.requireBool(this.parseUnary(), '!');
    }
    if (this.eatOp('-')) {
      const v = this.parseUnary();
      if (isAny(v)) return ANY;
      if (typeof v !== 'number') throw new ExpressionError('一元 "-" 仅支持数字');
      return -v;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Value {
    const t = this.peek();
    if (!t) throw new ExpressionError('表达式意外结束');
    if (t.type === 'number') {
      this.pos += 1;
      return Number(t.value);
    }
    if (t.type === 'string') {
      this.pos += 1;
      return t.value;
    }
    if (t.type === 'ident') {
      this.pos += 1;
      if (KEYWORDS.has(t.value)) return t.value === 'true';
      if (Object.prototype.hasOwnProperty.call(this.variables, t.value)) {
        return this.variables[t.value];
      }
      if (this.parseOnly) return ANY;
      throw new ExpressionError(`未定义的上下文变量 "${t.value}"`);
    }
    if (t.type === 'lparen') {
      this.pos += 1;
      const v = this.parseOr();
      if (!this.peek() || this.peek()?.type !== 'rparen') {
        throw new ExpressionError(`位置 ${t.pos}: 括号未闭合`);
      }
      this.pos += 1;
      return v;
    }
    throw new ExpressionError(`位置 ${t.pos}: 无法识别的记号 "${t.value}"`);
  }

  private requireBool(v: Value, op: string): boolean {
    if (isAny(v)) return true; // parse-only 模式：未知变量视为合法布尔位
    if (typeof v !== 'boolean') {
      throw new ExpressionError(`运算符 "${op}" 要求布尔操作数`);
    }
    return v;
  }
}

function compare(left: Value, right: Value, op: string): boolean {
  if (isAny(left) || isAny(right)) return false; // parse-only 模式：比较结果不判定
  if (op === '==' || op === '!=') {
    if (typeof left !== typeof right) {
      throw new ExpressionError(`运算符 "${op}" 要求两侧类型一致`);
    }
    return op === '==' ? left === right : left !== right;
  }
  if (typeof left !== typeof right) {
    throw new ExpressionError(`运算符 "${op}" 要求两侧类型一致`);
  }
  if (typeof left === 'boolean') {
    throw new ExpressionError(`运算符 "${op}" 不支持布尔比较`);
  }
  return op === '>' ? left > right
    : op === '<' ? left < right
    : op === '>=' ? left >= right
    : left <= right;
}

/** 语法解析（不做变量求值，供校验器 R6 使用）：合法返回 true，非法抛出 ExpressionError */
export function validateExpression(expression: string): boolean {
  new Parser(tokenize(expression), {}, true).evaluate();
  return true;
}

/** 对上下文变量表求值 */
export function evaluateExpression(
  expression: string,
  variables: Record<string, ExprValue>,
): boolean {
  const result = new Parser(tokenize(expression), variables).evaluate();
  if (typeof result !== 'boolean') {
    throw new ExpressionError('条件表达式结果必须为布尔值');
  }
  return result;
}
