/**
 * VTO 数据契约 —— 与《设计规格说明书》第 5 章严格对齐（冻结基线，勿私自改动）。
 * Plan / Node / Edge / Run / TaskSpec 是画布（B）、引擎（C）、存储（D）三方唯一事实来源。
 */

/** 节点类型：开始 / 任务 / 条件分支 / 延时 / 结束 */
export type NodeType = 'start' | 'task' | 'condition' | 'delay' | 'end';

/** 节点属性（按类型约束，见规格 4.1.1 属性表） */
export interface NodeProps {
  /** 任务名，显示在节点上（task/condition/delay），1~50 字符 */
  name?: string;
  /** task：模拟执行耗时 0~60000 ms */
  duration?: number;
  /** task：失败自动重试次数 0~3 */
  retry?: number;
  /** task：演示用失败注入概率 0~1 */
  failRate?: number;
  /** task：成功后将 {变量名: true} 写入执行上下文 */
  output?: string;
  /** delay：延时等待时长 0~60000 ms */
  wait?: number;
  /** condition：受限文法条件表达式，见规格 4.2.6 */
  expression?: string;
}

export interface PlanNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  props: NodeProps;
}

export interface PlanEdge {
  id: string;
  source: string;
  target: string;
  /** condition 出边为 true/false，其余可作说明文字 */
  label?: string;
}

export interface PlanMeta {
  /** 全局并发上限，默认 3 */
  maxConcurrency?: number;
  /** 上游失败时是否忽略失败继续执行（默认 false，fail-fast） */
  continueOnError?: boolean;
  description?: string;
}

/** 编排方案（规格 5.2） */
export interface Plan {
  id: string;
  /** 方案名，≤50 字符 */
  name: string;
  /** 数据格式版本，当前 "1.0" */
  version: string;
  meta?: PlanMeta;
  nodes: PlanNode[];
  edges: PlanEdge[];
  createdAt: string;
  updatedAt: string;
}

/** 方案索引条目（规格 4.3.1） */
export interface PlanIndexItem {
  id: string;
  name: string;
  version: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 节点运行状态（规格 4.2.4 状态机） */
export type NodeRunStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'CANCELED';

/** 运行级状态（规格 4.2.4：IDLE → VALIDATING → RUNNING → SUCCESS/FAILED/CANCELED） */
export type RunStatus = 'IDLE' | 'VALIDATING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELED';

/** 节点运行态（规格 5.4 NodeRunState） */
export interface NodeRunState {
  status: NodeRunStatus;
  startedAt?: string;
  finishedAt?: string;
  /** 已执行尝试次数（含重试） */
  attempt?: number;
  message?: string;
  output?: unknown;
}

/** 结构化日志（规格 5.4 LogEntry） */
export interface LogEntry {
  seq: number;
  time: string;
  nodeId: string;
  nodeName: string;
  /** start / success / fail / retry / skip / cancel */
  event: 'start' | 'success' | 'fail' | 'retry' | 'skip' | 'cancel';
  message: string;
}

/** 运行快照（规格 5.4） */
export interface Run {
  id: string;
  planId: string;
  planName: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  /** nodeId → NodeRunState */
  nodeStates: Record<string, NodeRunState>;
  /** 按 seq 递增的结构化日志 */
  logs: LogEntry[];
  error: string | null;
}

/** 任务分解中间结果条目（规格 5.5） */
export interface TaskSpecTask {
  /** 原始条目编号（可回溯），如 "1.1" */
  key: string;
  /** 任务名（可在确认界面修改） */
  name: string;
  type: NodeType;
  /** 依赖的任务 key 列表 */
  dependsOn: string[];
  /** 同组值并行（fan-out），无则 null */
  parallelGroup: number | null;
  /** 绑定条件分支 true/false（仅分支绑定条目携带） */
  branch?: 'true' | 'false';
  /** 条件表达式（仅 condition 携带） */
  expression?: string;
  /** 输出变量（仅被条件依赖的前置任务携带） */
  output?: string;
  /** 延时时长（仅 delay 携带，扩展字段，供画布生成 delay 节点） */
  wait?: number;
}

/** 任务分解结果（规格 5.5） */
export interface TaskSpec {
  /** 来源规格名称/文件名 */
  source: string;
  detectedFormat: 'markdown' | 'numbered';
  tasks: TaskSpecTask[];
}

/** 校验错误明细（规格 4.2.2，可定位到节点） */
export interface ValidationDetail {
  /** 出错节点 id（运行级/结构级错误可为空） */
  nodeId?: string;
  /** 规则编号 R1~R8 */
  rule: string;
  message: string;
}

/** 执行上下文（规格 4.2.6） */
export interface RunContext {
  variables: Record<string, boolean | number | string>;
  outputs: Record<string, unknown>;
}
