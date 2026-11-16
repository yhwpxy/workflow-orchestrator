/**
 * M3 - 运行管理器：运行的创建、注册、查询、停止与快照增量查询。
 * 同一方案同时只允许一个执行中的运行（规格 6.2：40901 方案正在执行中）。
 */
import { customAlphabet } from 'nanoid';
import type { Plan, Run } from '../types.js';
import { ERR } from '../errors.js';
import { PlanExecutor } from './executor.js';
import { validate } from './validator.js';

const newRunId = customAlphabet('123456789abcdefghijkmnpqrstuvwxyz', 8);

export interface RunPersistService {
  save(run: Run): Promise<void>;
}

export class RunManager {
  private readonly runs = new Map<string, Run>();
  private readonly activeByPlan = new Map<string, string>(); // planId → 执行中的 runId
  private readonly cancellers = new Map<string, () => void>();

  constructor(private readonly persistService?: RunPersistService) {}

  /**
   * 校验并执行方案（规格 4.2.3 第 1~2 条：先全量校验，不通过拒绝执行）。
   * 校验失败 → 40002（附节点级 details）；方案执行中 → 40901。
   * @returns runId
   */
  start(plan: Plan): string {
    const activeRunId = this.activeByPlan.get(plan.id);
    if (activeRunId) {
      throw ERR.PLAN_BUSY(plan.id);
    }

    const { ok, details } = validate(plan);
    if (!ok) throw ERR.VALIDATION_FAILED(details);

    const now = new Date().toISOString();
    const run: Run = {
      id: `run_${newRunId()}`,
      planId: plan.id,
      planName: plan.name,
      status: 'VALIDATING',
      startedAt: now,
      finishedAt: null,
      nodeStates: Object.fromEntries(plan.nodes.map((n) => [n.id, { status: 'PENDING' as const }])),
      logs: [],
      error: null,
    };
    this.runs.set(run.id, run);
    this.activeByPlan.set(plan.id, run.id);

    const executor = new PlanExecutor(plan, run, {
      persist: (r) => void this.persistService?.save(r),
      onFinish: (r) => {
        if (this.activeByPlan.get(r.planId) === r.id) this.activeByPlan.delete(r.planId);
        this.cancellers.delete(r.id);
      },
    });
    this.cancellers.set(run.id, () => executor.cancel());
    executor.start(); // VALIDATING → RUNNING（同步初始化，随后异步调度）
    return run.id;
  }

  /** 停止运行；运行不存在 → 40402；已结束则幂等返回当前状态 */
  cancel(runId: string): Run {
    const run = this.getRun(runId);
    if (run.status === 'VALIDATING' || run.status === 'RUNNING') {
      this.cancellers.get(runId)?.();
    }
    return run;
  }

  getRun(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw ERR.RUN_NOT_FOUND(runId);
    return run;
  }

  /** 快照查询：?since=seq 时仅返回 logs[seq > since] 与完整 nodeStates（规格 6.2） */
  snapshot(runId: string, since?: number): Run {
    const run = this.getRun(runId);
    if (since === undefined || !Number.isFinite(since)) return run;
    return {
      ...run,
      logs: run.logs.filter((l) => l.seq > since),
    };
  }
}
