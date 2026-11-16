/**
 * M4 存储桩（负责人 C 提供的最小实现，供引擎独立联调与演示）。
 *
 * ⚠️ 归属说明：持久化属于 M4（负责人 D）。本文件按规格 6.5 的服务签名
 * （planService.save/list/get/delete + runService.save/get）实现文件存储，
 * D 替换实现时只需保持同签名，路由层与引擎层零改动。
 *
 * 已按规格实现：原子写（临时文件 + rename，NFR-05）、按文件写串行化、版本防御（4.3.3）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { customAlphabet } from 'nanoid';
import type { Plan, PlanIndexItem, Run } from '../types.js';
import { ERR } from '../errors.js';

const tmpId = customAlphabet('123456789abcdefghijkmnpqrstuvwxyz', 6);
const CURRENT_VERSION = '1.0';

/** 方案 id 生成（plan_ 前缀 + nanoid 短随机串，规格 5.1） */
export function newPlanId(): string {
  return `plan_${customAlphabet('123456789abcdefghijkmnpqrstuvwxyz', 8)()}`;
}

export interface PlanService {
  save(plan: Plan): Promise<{ id: string; updatedAt: string }>;
  list(): Promise<PlanIndexItem[]>;
  get(id: string): Promise<Plan>;
  delete(id: string): Promise<void>;
}

export interface RunService {
  save(run: Run): Promise<void>;
  get(runId: string): Promise<Run>;
}

/** 方案 JSON 结构校验（保存/导入入口的防御性检查，图结构校验在执行时进行） */
function assertPlanStructure(plan: Plan): void {
  if (typeof plan?.id !== 'string' || plan.id.length === 0) throw ERR.BAD_PLAN_STRUCTURE('缺少方案 id');
  if (typeof plan.name !== 'string' || plan.name.trim().length === 0) throw ERR.BAD_PLAN_STRUCTURE('缺少方案名 name');
  if (plan.name.length > 50) throw ERR.BAD_PLAN_STRUCTURE('方案名超过 50 字符');
  if (typeof plan.version !== 'string') throw ERR.BAD_PLAN_STRUCTURE('缺少 version 字段');
  if (compareVersion(plan.version, CURRENT_VERSION) > 0) {
    throw ERR.BAD_PLAN_STRUCTURE(`该方案由更新版本创建（${plan.version} > ${CURRENT_VERSION}），拒绝载入`);
  }
  if (!Array.isArray(plan.nodes) || !Array.isArray(plan.edges)) {
    throw ERR.BAD_PLAN_STRUCTURE('nodes/edges 必须为数组');
  }
  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (typeof node?.id !== 'string' || node.id.length === 0) throw ERR.BAD_PLAN_STRUCTURE('存在缺少 id 的节点');
    if (ids.has(node.id)) throw ERR.BAD_PLAN_STRUCTURE(`节点 ID 重复: ${node.id}`);
    ids.add(node.id);
  }
  for (const edge of plan.edges) {
    if (typeof edge?.id !== 'string' || typeof edge?.source !== 'string' || typeof edge?.target !== 'string') {
      throw ERR.BAD_PLAN_STRUCTURE('边缺少 id/source/target');
    }
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      throw ERR.BAD_PLAN_STRUCTURE(`边 ${edge.id} 两端节点不存在`);
    }
  }
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export class FileStorage {
  /** 方案服务（规格 6.5 planService 签名） */
  readonly plans: PlanService;
  /** 运行快照服务（规格 6.5 runService 签名） */
  readonly runs: RunService;

  private readonly plansDir: string;
  private readonly runsDir: string;
  /** 全局写串行化：避免并发写交错（规格 4.3.1） */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(storageRoot?: string) {
    const root = storageRoot ?? process.env.VTO_STORAGE_DIR ?? path.resolve(process.cwd(), 'storage');
    this.plansDir = path.join(root, 'plans');
    this.runsDir = path.join(root, 'runs');

    this.plans = {
      save: (plan) => this.savePlan(plan),
      list: () => this.listPlans(),
      get: (id) => this.getPlan(id),
      delete: (id) => this.deletePlan(id),
    };
    this.runs = {
      save: (run) => this.saveRun(run),
      get: (id) => this.getRun(id),
    };
  }

  async init(): Promise<void> {
    await fs.mkdir(this.plansDir, { recursive: true });
    await fs.mkdir(this.runsDir, { recursive: true });
  }

  // ---- 方案（规格 4.3.2） ----

  private async savePlan(plan: Plan): Promise<{ id: string; updatedAt: string }> {
    assertPlanStructure(plan);
    const now = new Date().toISOString();
    const isNew = !plan.createdAt;
    const record: Plan = {
      ...plan,
      version: plan.version || CURRENT_VERSION,
      createdAt: isNew ? now : plan.createdAt,
      updatedAt: now,
    };
    await this.enqueue(() => this.writeJson(this.planFile(record.id), record));
    return { id: record.id, updatedAt: record.updatedAt };
  }

  private async listPlans(): Promise<PlanIndexItem[]> {
    let files: string[];
    try {
      files = (await fs.readdir(this.plansDir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
    } catch {
      return [];
    }
    const items: PlanIndexItem[] = [];
    for (const file of files) {
      try {
        const plan = JSON.parse(await fs.readFile(path.join(this.plansDir, file), 'utf-8')) as Plan;
        items.push({
          id: plan.id,
          name: plan.name,
          version: plan.version,
          nodeCount: Array.isArray(plan.nodes) ? plan.nodes.length : 0,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        });
      } catch {
        // 损坏文件跳过并提示，不阻塞列表（规格 4.3.3 友好容错）
        console.warn(`[storage] 忽略损坏的方案文件: ${file}`);
      }
    }
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return items;
  }

  private async getPlan(id: string): Promise<Plan> {
    try {
      return JSON.parse(await fs.readFile(this.planFile(id), 'utf-8')) as Plan;
    } catch {
      throw ERR.PLAN_NOT_FOUND(id);
    }
  }

  private async deletePlan(id: string): Promise<void> {
    await this.getPlan(id); // 不存在 → 40401
    await this.enqueue(() => fs.rm(this.planFile(id), { force: true }));
  }

  // ---- 运行快照 ----

  private async saveRun(run: Run): Promise<void> {
    await this.enqueue(() => this.writeJson(this.runFile(run.id), run));
  }

  private async getRun(runId: string): Promise<Run> {
    try {
      return JSON.parse(await fs.readFile(this.runFile(runId), 'utf-8')) as Run;
    } catch {
      throw ERR.RUN_NOT_FOUND(runId);
    }
  }

  // ---- 内部工具 ----

  private planFile(id: string): string {
    return path.join(this.plansDir, `${id}.json`);
  }

  private runFile(id: string): string {
    return path.join(this.runsDir, `${id}.json`);
  }

  /** 原子写：先写 <file>.tmp 再 rename（NFR-05） */
  private async writeJson(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.${tmpId()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, file);
  }

  /** 写串行化 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
