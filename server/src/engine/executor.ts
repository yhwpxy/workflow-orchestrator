/**
 * M3 - 调度执行器（规格 4.2.3 / 4.2.4）。
 *
 * 调度模型：令牌投递（token passing）。
 *  - 每条入边定态后向目标节点投递一个令牌：SUCCESS / SKIPPED / FAILED；
 *  - 条件节点 SUCCESS 时，激活侧出边投递 SUCCESS，未激活侧投递 SKIPPED，
 *    SKIPPED 沿下游传播、遇汇聚点（入度>1）自然停下等待其余入边；
 *  - 节点在"全部入边已投递"时判定：含 SUCCESS → 进入就绪队列执行；全部 SKIPPED → 本节点 SKIPPED；
 *  - fail-fast：收到 FAILED 令牌的节点立即 SKIPPED 并向下传播（meta.continueOnError=true 时忽略）；
 *  - 就绪队列由信号量控制，在途执行数 ≤ maxConcurrency（默认 3）；
 *  - 全部节点定态后：存在 FAILED 则运行 FAILED，否则 SUCCESS；用户停止 → 未定态节点全部 CANCELED。
 *
 * 每次状态变化更新 Run 快照并追加结构化日志（规格 5.4）。
 */
import type {
  LogEntry,
  NodeRunStatus,
  Plan,
  PlanNode,
  Run,
  RunContext,
} from '../types.js';
import { evaluateExpression } from './expression/evaluator.js';
import { computeLevels } from './levels.js';

export interface ExecutorOptions {
  /** 失败注入用随机源（默认 Math.random），测试可注入固定值 */
  rng?: () => number;
  /** 快照落盘回调（runService.save） */
  persist?: (run: Run) => void;
  /** 运行终态回调（SUCCESS/FAILED/CANCELED），供运行管理器释放方案执行锁 */
  onFinish?: (run: Run) => void;
}

const SETTLED: ReadonlySet<NodeRunStatus> = new Set(['SUCCESS', 'FAILED', 'SKIPPED', 'CANCELED']);
type Token = 'SUCCESS' | 'SKIPPED' | 'FAILED';

export class PlanExecutor {
  private readonly plan: Plan;
  private readonly run: Run;
  private readonly rng: () => number;
  private readonly persist: (run: Run) => void;
  private readonly onFinish?: (run: Run) => void;

  private readonly nodeById = new Map<string, PlanNode>();
  private readonly outEdges = new Map<string, Plan['edges']>();
  private readonly inEdges = new Map<string, Plan['edges']>();
  private readonly levels = new Map<string, number>();

  private readonly tokens = new Map<string, Token>(); // edgeId → 已投递令牌
  private readonly pendingIn = new Map<string, number>(); // nodeId → 未投递入边数
  /** nodeId → 已投递令牌的入边集合（按边计数，避免同类型令牌被去重） */
  private readonly receivedEdges = new Map<string, Set<string>>();
  /** nodeId → 收到的令牌类型集合（用于就绪判定） */
  private readonly receivedTokens = new Map<string, Set<Token>>();
  private readonly chosenBranch = new Map<string, 'true' | 'false'>(); // condition 的路由结果

  private readonly context: RunContext = { variables: {}, outputs: {} };
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly queue: string[] = [];
  private inFlight = 0;
  private maxConcurrency: number;
  private continueOnError: boolean;
  private finished = false;

  constructor(plan: Plan, run: Run, options: ExecutorOptions = {}) {
    this.plan = plan;
    this.run = run;
    this.rng = options.rng ?? Math.random;
    this.persist = options.persist ?? (() => undefined);
    this.onFinish = options.onFinish;
    this.maxConcurrency = Math.min(50, Math.max(1, plan.meta?.maxConcurrency ?? 3));
    this.continueOnError = plan.meta?.continueOnError === true;

    for (const node of plan.nodes) {
      this.nodeById.set(node.id, node);
      this.outEdges.set(node.id, []);
      this.inEdges.set(node.id, []);
      this.pendingIn.set(node.id, 0);
      this.receivedEdges.set(node.id, new Set());
      this.receivedTokens.set(node.id, new Set());
    }
    for (const edge of plan.edges) {
      if (!this.nodeById.has(edge.source) || !this.nodeById.has(edge.target)) continue;
      this.outEdges.get(edge.source)?.push(edge);
      this.inEdges.get(edge.target)?.push(edge);
      this.pendingIn.set(edge.target, (this.pendingIn.get(edge.target) ?? 0) + 1);
    }
    this.levels = computeLevels(plan.nodes, plan.edges);
  }

  /** 启动执行（前置校验已由 runManager 完成） */
  start(): void {
    this.run.status = 'RUNNING';
    const waveCount = new Set(this.levels.values()).size;
    this.log('system', '系统', 'start', `运行开始（共 ${waveCount} 个波次，并发上限 ${this.maxConcurrency}）`);

    // 入度为 0 的节点（唯一 start）立即就绪
    for (const [id, count] of this.pendingIn) {
      if (count === 0) this.queue.push(id);
    }
    this.dispatch();
    this.snapshot();
  }

  /** 用户停止：未定态节点（PENDING/RUNNING）全部 CANCELED（规格 4.2.3 第 7 条） */
  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.queue.length = 0;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const now = new Date().toISOString();
    for (const [id, state] of Object.entries(this.run.nodeStates)) {
      if (!SETTLED.has(state.status)) {
        state.status = 'CANCELED';
        state.finishedAt = now;
        this.log(id, this.nodeName(id), 'cancel', '用户停止，节点取消');
      }
    }
    this.run.status = 'CANCELED';
    this.run.finishedAt = now;
    this.run.error = '用户手动停止';
    this.log('system', '系统', 'cancel', '运行已停止');
    this.snapshot();
    this.onFinish?.(this.run);
  }

  // ---------- 调度 ----------

  private dispatch(): void {
    if (this.finished) return;
    while (this.queue.length > 0 && this.inFlight < this.maxConcurrency) {
      const id = this.queue.shift();
      if (id === undefined) break;
      this.inFlight += 1;
      this.runNode(id);
    }
  }

  /** 投递令牌到边的目标节点 */
  private deliver(edge: Plan['edges'][number], token: Token): void {
    if (this.finished) return;
    this.tokens.set(edge.id, token);
    const target = edge.target;
    const edges = this.receivedEdges.get(target);
    const tokenSet = this.receivedTokens.get(target);
    if (!edges || !tokenSet || this.isSettled(target)) return;
    edges.add(edge.id);
    tokenSet.add(token);

    // fail-fast：收到 FAILED 立即跳过并向下传播
    if (token === 'FAILED' && !this.continueOnError) {
      this.settle(target, 'SKIPPED', '上游任务失败，跳过（fail-fast）');
      return;
    }

    const pending = this.pendingIn.get(target) ?? 0;
    if (edges.size < pending) return; // 还有入边未定态（汇聚等待）

    // 全部入边已定态：含 SUCCESS（或 continueOnError 时含 FAILED）则执行，否则跳过
    const hasGo = tokenSet.has('SUCCESS') || (this.continueOnError && tokenSet.has('FAILED'));
    if (hasGo) {
      this.queue.push(target);
      this.dispatch();
    } else {
      this.settle(target, 'SKIPPED', '分支未激活/上游跳过');
    }
  }

  /** 节点定态：写状态、记日志、沿出边传播令牌 */
  private settle(id: string, status: Exclude<NodeRunStatus, 'PENDING' | 'RUNNING'>, message?: string): void {
    if (this.isSettled(id) || this.finished) return;
    const state = this.run.nodeStates[id];
    if (!state) return;
    const wasRunning = state.status === 'RUNNING';
    state.status = status;
    state.finishedAt = new Date().toISOString();
    if (message) state.message = message;

    switch (status) {
      case 'SUCCESS':
        this.log(id, this.nodeName(id), 'success', message ?? '执行成功');
        break;
      case 'FAILED':
        this.log(id, this.nodeName(id), 'fail', message ?? '执行失败');
        break;
      case 'SKIPPED':
        this.log(id, this.nodeName(id), 'skip', message ?? '节点跳过');
        break;
      case 'CANCELED':
        this.log(id, this.nodeName(id), 'cancel', message ?? '节点取消');
        break;
    }

    this.propagate(id, status);
    this.checkCompletion();
    this.snapshot();
    if (wasRunning) {
      // 同步完成的节点（start/condition/零耗时）在此释放在途名额
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.dispatch();
    }
  }

  /** 沿出边传播令牌 */
  private propagate(id: string, status: NodeRunStatus): void {
    const outs = this.outEdges.get(id) ?? [];
    if (status === 'CANCELED') return; // 停止后不再传播

    if (this.nodeById.get(id)?.type === 'condition') {
      if (status === 'SUCCESS') {
        const branch = this.chosenBranch.get(id);
        for (const edge of outs) {
          this.deliver(edge, branch !== undefined && edge.label === branch ? 'SUCCESS' : 'SKIPPED');
        }
      } else {
        // 被跳过/失败的条件无法路由：全部出边按 SKIPPED 传播
        for (const edge of outs) this.deliver(edge, 'SKIPPED');
      }
      return;
    }

    for (const edge of outs) {
      if (status === 'SUCCESS') this.deliver(edge, 'SUCCESS');
      else if (status === 'SKIPPED') this.deliver(edge, 'SKIPPED');
      else if (status === 'FAILED') this.deliver(edge, 'FAILED');
    }
  }

  // ---------- 节点执行语义（规格 4.2.3 第 5 条） ----------

  private runNode(id: string): void {
    const node = this.nodeById.get(id);
    const state = this.run.nodeStates[id];
    if (!node || !state) {
      this.inFlight -= 1;
      return;
    }
    state.status = 'RUNNING';
    state.startedAt = new Date().toISOString();
    state.attempt = (state.attempt ?? 0) + 1;
    state.message = undefined;
    const wave = this.levels.get(id);
    this.log(id, this.nodeName(id), 'start', `开始执行（波次 ${(wave ?? 0) + 1}）`);
    this.snapshot();

    switch (node.type) {
      case 'start':
        this.settle(id, 'SUCCESS', '运行入口');
        break;
      case 'end':
        this.settle(id, 'SUCCESS', '运行结束');
        break;
      case 'delay':
        this.timer(node.props?.wait ?? 0, () => this.settle(id, 'SUCCESS', `延时 ${node.props?.wait ?? 0}ms`));
        break;
      case 'condition':
        this.runCondition(id);
        break;
      case 'task':
        this.runTaskAttempt(id, state.attempt ?? 1);
        break;
    }
  }

  /** 条件分支：受限求值 → 激活 true/false 一侧出边 */
  private runCondition(id: string): void {
    const node = this.nodeById.get(id);
    const expression = node?.props?.expression ?? '';
    let branch: 'true' | 'false';
    try {
      branch = evaluateExpression(expression, this.context.variables) ? 'true' : 'false';
    } catch (err) {
      this.settle(id, 'FAILED', `条件表达式求值失败: ${(err as Error).message}`);
      return;
    }
    this.chosenBranch.set(id, branch);
    this.settle(id, 'SUCCESS', `表达式 "${expression}" 求值为 ${branch}，走 ${branch} 分支`);
  }

  /** task：模拟耗时 → 按 failRate 注入失败 → 退避重试（500ms × attempt） */
  private runTaskAttempt(id: string, attempt: number): void {
    const node = this.nodeById.get(id);
    if (!node) return;
    const duration = node.props?.duration ?? 0;
    this.timer(duration, () => {
      if (this.finished) return;
      const failRate = node.props?.failRate ?? 0;
      const failed = this.rng() < failRate;
      const retry = node.props?.retry ?? 0;
      if (!failed) {
        const output = node.props?.output;
        if (output) {
          this.context.variables[output] = true;
          this.context.outputs[id] = { [output]: true };
        }
        const state = this.run.nodeStates[id];
        if (state) state.output = output ? { [output]: true } : undefined;
        this.settle(id, 'SUCCESS', attempt > 1 ? `第 ${attempt} 次尝试成功` : undefined);
        return;
      }
      if (attempt <= retry) {
        const state = this.run.nodeStates[id];
        if (state) {
          state.attempt = attempt + 1;
          state.message = `第${attempt}次尝试失败，重试中`;
        }
        this.log(id, this.nodeName(id), 'retry', `第${attempt}次尝试失败，${500 * attempt}ms 后重试`);
        this.snapshot();
        this.timer(500 * attempt, () => this.runTaskAttempt(id, attempt + 1));
        return;
      }
      this.settle(id, 'FAILED', retry > 0 ? `重试耗尽（共 ${attempt} 次尝试）` : '执行失败');
    });
  }

  // ---------- 收尾 ----------

  private checkCompletion(): void {
    if (this.finished) return;
    const states = Object.values(this.run.nodeStates);
    if (states.length === 0 || !states.every((s) => SETTLED.has(s.status))) return;
    this.finished = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const hasFailed = states.some((s) => s.status === 'FAILED');
    this.run.status = hasFailed ? 'FAILED' : 'SUCCESS';
    this.run.finishedAt = new Date().toISOString();
    this.log('system', '系统', hasFailed ? 'fail' : 'success', hasFailed ? '运行失败：存在失败节点' : '运行成功');
    this.onFinish?.(this.run);
  }

  // ---------- 工具 ----------

  private timer(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, Math.max(0, ms));
    this.timers.add(t);
  }

  private isSettled(id: string): boolean {
    return SETTLED.has(this.run.nodeStates[id]?.status ?? 'PENDING');
  }

  private nodeName(id: string): string {
    const node = this.nodeById.get(id);
    if (!node) return id;
    if (node.type === 'start') return '开始';
    if (node.type === 'end') return '结束';
    return node.props?.name?.trim() || id;
  }

  private log(nodeId: string, nodeName: string, event: LogEntry['event'], message: string): void {
    this.run.logs.push({
      seq: this.run.logs.length + 1,
      time: new Date().toISOString(),
      nodeId,
      nodeName,
      event,
      message,
    });
  }

  /** 快照落盘（每次状态变化，规格 4.2.3 第 8 条） */
  private snapshot(): void {
    // 浅拷贝避免持久化层与运行期对象互相影响
    const copy: Run = {
      ...this.run,
      nodeStates: Object.fromEntries(
        Object.entries(this.run.nodeStates).map(([k, v]) => [k, { ...v }]),
      ),
      logs: [...this.run.logs],
    };
    Promise.resolve(this.persist(copy)).catch(() => undefined);
  }
}
