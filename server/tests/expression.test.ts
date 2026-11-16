/**
 * 受限表达式求值器单元测试（规格 4.2.6 / NFR-10）。
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateExpression,
  validateExpression,
  ExpressionError,
} from '../src/engine/expression/evaluator.js';

describe('表达式: 基础求值', () => {
  const vars = { passed: true, count: 3, name: 'abc', failed: false };

  it('布尔字面量与相等比较', () => {
    expect(evaluateExpression('passed == true', vars)).toBe(true);
    expect(evaluateExpression('passed != false', vars)).toBe(true);
    expect(evaluateExpression('failed == false', vars)).toBe(true);
  });

  it('数值比较（>= <= > <）', () => {
    expect(evaluateExpression('count >= 3', vars)).toBe(true);
    expect(evaluateExpression('count > 3', vars)).toBe(false);
    expect(evaluateExpression('count <= 3', vars)).toBe(true);
    expect(evaluateExpression('count < 10', vars)).toBe(true);
  });

  it('字符串字面量与比较', () => {
    expect(evaluateExpression("name == 'abc'", vars)).toBe(true);
    expect(evaluateExpression('name != "x"', vars)).toBe(true);
    expect(evaluateExpression("'a' < 'b'", vars)).toBe(true);
  });

  it('逻辑运算与优先级（! 高于 && 高于 ||）', () => {
    expect(evaluateExpression('passed && count >= 3', vars)).toBe(true);
    expect(evaluateExpression('!passed || count > 5', vars)).toBe(false);
    expect(evaluateExpression('!failed', vars)).toBe(true);
    // && 优先于 ||
    expect(evaluateExpression('failed || passed && count == 3', vars)).toBe(true);
  });

  it('括号分组', () => {
    expect(evaluateExpression('(failed || passed) && count == 3', vars)).toBe(true);
  });

  it('算术比较的负号', () => {
    expect(evaluateExpression('count > -1', vars)).toBe(true);
  });

  it('示例表达式（规格 4.2.6）', () => {
    expect(evaluateExpression('passed == true && count >= 3', vars)).toBe(true);
  });
});

describe('表达式: 类型与安全约束', () => {
  it('逻辑运算符要求布尔操作数', () => {
    expect(() => evaluateExpression('count && true', {})).toThrowError(ExpressionError);
  });

  it('比较运算符要求两侧类型一致', () => {
    expect(() => evaluateExpression('count == "3"', { count: 3 })).toThrowError(ExpressionError);
    expect(() => evaluateExpression('true > false', {})).toThrowError(ExpressionError);
  });

  it('未定义变量报错（校验期无法发现，运行期报 FAILED）', () => {
    expect(() => evaluateExpression('unknown == true', {})).toThrowError(/未定义的上下文变量/);
  });

  it('结果非布尔报错', () => {
    expect(() => evaluateExpression('count', { count: 3 })).toThrowError(/布尔/);
  });

  it('禁止赋值', () => {
    expect(() => validateExpression('a = 1')).toThrowError(ExpressionError);
  });

  it('禁止函数调用与任意代码', () => {
    expect(() => validateExpression('eval("1")')).toThrowError(ExpressionError);
    expect(() => validateExpression('alert(1) == 1')).toThrowError(ExpressionError);
    expect(() => validateExpression('process.exit(1)')).toThrowError(ExpressionError);
  });

  it('语法错误报告位置', () => {
    expect(() => validateExpression('a ==')).toThrowError(ExpressionError);
    expect(() => validateExpression('(a == true')).toThrowError(/括号/);
    expect(() => validateExpression('a == "未闭合')).toThrowError(/未闭合/);
  });
});

describe('表达式: validateExpression（校验器 R6 使用）', () => {
  it('合法表达式不抛错（变量允许运行期才出现）', () => {
    expect(validateExpression('passed == true && count >= 3')).toBe(true);
    expect(validateExpression('!(a == 1 || b != 2)')).toBe(true);
    expect(validateExpression("'中文变量' == name")).toBe(true);
  });
});
