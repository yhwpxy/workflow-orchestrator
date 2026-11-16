/**
 * M1 分解器单元测试（规格 8.2 分解器测试点 + AC-01）。
 */
import { describe, expect, it } from 'vitest';
import { decompose } from '../src/engine/decompose/index.js';
import { ApiError } from '../src/errors.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const specText = readFileSync(path.join(here, '../examples/login-spec.md'), 'utf-8');

describe('decompose: 附录 A 示例（AC-01）', () => {
  const taskSpec = decompose(specText);

  it('来源与格式识别正确', () => {
    expect(taskSpec.source).toBe('用户登录功能');
    expect(taskSpec.detectedFormat).toBe('markdown');
  });

  it('分解结果与规格 5.5 预期一致', () => {
    expect(taskSpec.tasks).toEqual([
      { key: '1.1', name: '校验用户名格式', type: 'task', dependsOn: [], parallelGroup: 1 },
      { key: '1.2', name: '校验密码非空', type: 'task', dependsOn: [], parallelGroup: 1 },
      { key: '2.1', name: '查询用户信息', type: 'task', dependsOn: ['1.1', '1.2'], parallelGroup: null },
      { key: '2.2', name: '比对密码哈希', type: 'task', dependsOn: ['2.1'], parallelGroup: null, output: 'passed' },
      { key: '3.1', name: '认证是否通过', type: 'condition', dependsOn: ['2.2'], parallelGroup: null, expression: 'passed == true' },
      { key: '3.2', name: '记录登录日志', type: 'task', dependsOn: ['3.1'], parallelGroup: null, branch: 'true' },
      { key: '3.3', name: '生成会话令牌', type: 'task', dependsOn: ['3.2'], parallelGroup: null, branch: 'true' },
      { key: '3.4', name: '返回错误提示', type: 'task', dependsOn: ['3.1'], parallelGroup: null, branch: 'false' },
      { key: '3.5', name: '输出登录结果', type: 'end', dependsOn: ['3.3', '3.4'], parallelGroup: null },
    ]);
  });
});

describe('decompose: 关键词规则', () => {
  // 规则表语义："该条目与其同级条目标记为并行组"——同段落全部同级条目成组 fan-out，
  // 汇聚发生在下一段落首个条目（与附录 A 第 1 节模式一致）
  it('并行：前缀使同级条目形成并行组，下一段落条目汇聚（fan-out → join）', () => {
    const ts = decompose('# 测试\n## 1 并行段\n- 并行：任务A\n- 任务B\n- 任务C\n## 2 汇总\n- 汇总处理');
    expect(ts.tasks[0]).toMatchObject({ key: '1.1', name: '任务A', parallelGroup: 1, dependsOn: [] });
    expect(ts.tasks[1]).toMatchObject({ key: '1.2', name: '任务B', parallelGroup: 1, dependsOn: [] });
    expect(ts.tasks[2]).toMatchObject({ key: '1.3', name: '任务C', parallelGroup: 1, dependsOn: [] });
    expect(ts.tasks[3]).toMatchObject({ key: '2.1', name: '汇总处理', dependsOn: ['1.1', '1.2', '1.3'] });
  });

  it('判断/是否 → condition，且前置任务注入 output', () => {
    const ts = decompose('# 测试\n- 下载数据\n- 判断：数据是否有效\n- 处理数据（通过时）\n- 报告失败（未通过时）');
    expect(ts.tasks[1]).toMatchObject({ type: 'condition', expression: 'passed == true' });
    expect(ts.tasks[0]).toMatchObject({ type: 'task', output: 'passed' });
    expect(ts.tasks[2]).toMatchObject({ branch: 'true', dependsOn: ['1.2'] });
    expect(ts.tasks[3]).toMatchObject({ branch: 'false', dependsOn: ['1.2'] });
  });

  it('等待/延时 → delay，支持"N秒"提取', () => {
    const ts = decompose('# 测试\n- 等待3秒\n- 后续处理');
    expect(ts.tasks[0]).toMatchObject({ type: 'delay', wait: 3000 });
    expect(ts.tasks[1].dependsOn).toEqual(['1.1']);
  });

  it('末位条目命中 输出/结束/提交 → end', () => {
    const ts = decompose('# 测试\n- 处理数据\n- 提交结果');
    expect(ts.tasks[1]).toMatchObject({ type: 'end' });
  });

  it('非末位条目命中"输出"不会误判为 end', () => {
    const ts = decompose('# 测试\n- 输出格式校验\n- 后续处理');
    expect(ts.tasks[0]).toMatchObject({ type: 'task' });
  });
});

describe('decompose: 中文编号格式', () => {
  it('识别 一、/1. 层级；组条目不产生任务，叶子按位置编号并串行链接', () => {
    const ts = decompose(
      '一、准备\n1. 检查环境\n2. 安装依赖\n二、构建\n3. 编译代码\n4. 输出产物',
    );
    expect(ts.detectedFormat).toBe('numbered');
    // "准备/构建"为分组条目（有子级），叶子任务才是分解结果
    expect(ts.tasks.map((t) => [t.key, t.name, t.type])).toEqual([
      ['1.1', '检查环境', 'task'],
      ['1.2', '安装依赖', 'task'],
      ['2.1', '编译代码', 'task'],
      ['2.2', '输出产物', 'end'],
    ]);
    expect(ts.tasks[0].dependsOn).toEqual([]);
    expect(ts.tasks[1].dependsOn).toEqual(['1.1']);
    expect(ts.tasks[2].dependsOn).toEqual(['1.2']);
    expect(ts.tasks[3].dependsOn).toEqual(['2.1']);
  });

  it('纯阿拉伯数字编号文档', () => {
    const ts = decompose('1. 设计\n2. 开发\n3. 测试');
    expect(ts.detectedFormat).toBe('numbered');
    expect(ts.tasks.map((t) => t.key)).toEqual(['1', '2', '3']);
    expect(ts.tasks[2]).toMatchObject({ type: 'task' });
  });
});

describe('decompose: 清洗与健壮性', () => {
  it('统一全半角（全角冒号/括号/数字）', () => {
    const ts = decompose('# 测试\n- 并行：任务Ａ\n- 校验（通过时）\n- 失败（未通过时）\n- 提交');
    expect(ts.tasks[0]).toMatchObject({ name: '任务A', parallelGroup: 1 });
    expect(ts.tasks[1]).toMatchObject({ branch: 'true' });
    expect(ts.tasks[2]).toMatchObject({ branch: 'false' });
  });

  it('空文本 → 40003', () => {
    expect(() => decompose('   \n  \t ')).toThrowError(ApiError);
    try {
      decompose('');
    } catch (err) {
      expect((err as ApiError).code).toBe(40003);
    }
  });

  it('纯文本行按平铺条目处理（全角冒号统一为半角）', () => {
    const ts = decompose('第一步：准备工作\n第二步：执行任务');
    expect(ts.tasks).toHaveLength(2);
    expect(ts.tasks[0]).toMatchObject({ key: '1', name: '第一步:准备工作', type: 'task' });
  });

  it('允许指定 format 覆盖自动识别', () => {
    const ts = decompose('1. 任务甲\n2. 任务乙', { format: 'numbered' });
    expect(ts.detectedFormat).toBe('numbered');
    expect(ts.tasks).toHaveLength(2);
  });
});
