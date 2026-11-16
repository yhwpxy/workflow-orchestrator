# 可视化任务编排器（VTO）— 服务端

针对《可视化任务编排器设计规格说明书》V1.0 的服务端实现，覆盖 **负责人 C** 承担的模块：

| 模块 | 内容 | 状态 |
|------|------|------|
| **M1** 规格解析与任务分解 | `POST /api/decompose`：Markdown/中文编号识别、关键词规则、依赖推断 → TaskSpec | ✅ 已完成 |
| **M3** 执行引擎 | 校验器（R1~R8）、调度器（波次/并发/重试/条件/汇聚）、运行状态机、快照与日志、`/api/runs` 接口 | ✅ 已完成 |
| M4 数据持久化 | `server/src/services/storage.ts` 提供最小文件存储桩（接口与规格 6.5 一致），待负责人 D 替换 | 🔶 占位桩 |
| M2 画布编辑器 | 前端，负责人 B，见下方对接说明 | ⬜ 未包含 |

技术栈：Node.js ≥18 + Express 4 + TypeScript + Vitest（与规格 3.3 选型一致）。

## 快速启动

```bash
cd server
npm install
npm run dev        # 开发模式，默认 http://localhost:3000（PORT 环境变量可改）
npm test           # 运行 74 个单元/接口测试
npm run typecheck  # TypeScript 类型检查
```

一键体验（另开终端）：

```bash
# 1. 分解附录 A 示例规格（PowerShell）
$text = Get-Content server/examples/login-spec.md -Raw
Invoke-RestMethod -Uri http://localhost:3000/api/decompose -Method Post -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes(('{"text":' + ($text | ConvertTo-Json) + '}')))

# 2. 保存示例方案（examples/login-plan.json 内容作为 Body）后执行
# POST http://localhost:3000/api/plans            ← 完整 Plan JSON
# POST http://localhost:3000/api/plans/:id/execute
# GET  http://localhost:3000/api/runs/:runId      ← 每 500ms 轮询
```

## 目录结构

```
server/
├── examples/                  # 附录 A 规格 + 规格 5.2 示例方案
├── src/
│   ├── index.ts               # 入口（Express 监听）
│   ├── app.ts                 # 应用装配 + 统一错误体 { code, message, details? }
│   ├── routes.ts              # REST 路由（规格 6.1，含归属标注）
│   ├── types.ts               # 数据契约（规格第 5 章：Plan/Node/Edge/Run/TaskSpec）
│   ├── errors.ts              # 错误码（规格 6.3：40001/40002/…/50000）
│   ├── engine/
│   │   ├── decompose/         # M1：normalize（清洗）→ parse（任务树）→ rules（关键词）→ index（依赖推断）
│   │   ├── expression/        # M3：受限表达式求值（自研 tokenizer + 递归下降，NFR-10）
│   │   ├── validator.ts       # M3：全量校验 R1~R8（错误定位到节点）
│   │   ├── executor.ts        # M3：调度执行器（令牌投递模型）
│   │   ├── levels.ts          # M3：Kahn 拓扑分层（波次）
│   │   └── runManager.ts      # M3：运行注册表 / 快照增量查询 / 停止
│   └── services/storage.ts    # M4 存储桩：原子写（tmp+rename）+ 写串行化 + 版本防御
└── tests/                     # Vitest：分解器 / 表达式 / 校验器 / 执行器 / 接口（74 例）
```

## REST API（规格 6.1）

| 方法 | 路径 | 说明 | 归属 |
|------|------|------|------|
| POST | `/api/decompose` | `{ text, format?, source? }` → `{ ok, taskSpec }` | M1/C |
| POST | `/api/plans` | 新建（无 id）/更新（有 id）→ `{ id, updatedAt }` | M4/D（桩） |
| GET | `/api/plans` | 方案索引列表 `[{ id, name, version, nodeCount, createdAt, updatedAt }]` | M4/D（桩） |
| GET | `/api/plans/:id` | 方案详情（Plan JSON） | M4/D（桩） |
| DELETE | `/api/plans/:id` | 删除方案 | M4/D（桩） |
| POST | `/api/plans/:id/execute` | 校验并执行 → `{ runId }`；校验失败 40002 附 `details` | M3/C |
| GET | `/api/runs/:runId?since=seq` | 运行快照（`since` 只返回增量日志，nodeStates 恒为全量） | M3/C |
| POST | `/api/runs/:runId/cancel` | 停止运行（幂等） | M3/C |

错误码：`40001` 结构非法、`40002` 校验失败、`40003` 分解失败、`40401` 方案不存在、`40402` 运行不存在、`40901` 方案执行中、`50000` 内部错误。HTTP 状态按 400/404/409/500 映射。

## 执行引擎语义要点（规格 4.2）

- **校验前置（NFR-04）**：执行前全量校验 R1~R8，失败一律拒绝并附 `{ nodeId, rule, message }` 供画布定位高亮（AC-05）。
- **调度模型**：令牌投递——入边定态后向目标投递 SUCCESS/SKIPPED/FAILED 令牌；全部入边到位后，含 SUCCESS 即进入就绪队列；就绪队列由信号量控制在途数 ≤ `meta.maxConcurrency`（默认 3）。
- **条件路由**：condition 受限求值（白名单文法，禁止函数调用/赋值/任意 JS），激活侧出边放行，未激活侧沿下游传播 SKIPPED，遇汇聚点（入度>1）停下等待（AC-06）。
- **AND-Join**：汇聚节点等待全部入边定态；任一入边 FAILED → 本节点 SKIPPED 并向下传播（fail-fast）；`meta.continueOnError=true` 时忽略失败继续执行（AC-07）。
- **失败重试**：task 按 `failRate` 注入失败，`retry` 次自动重试，退避 500ms × attempt；重试耗尽 → FAILED。
- **状态机**：节点 PENDING → RUNNING → SUCCESS/FAILED/SKIPPED/CANCELED；运行 IDLE → VALIDATING → RUNNING → SUCCESS/FAILED/CANCELED。
- **快照与日志**：每次状态变化更新 Run 快照并落盘 `storage/runs/<runId>.json`；结构化日志 `{ seq, time, nodeId, nodeName, event, message }`（event: start/success/fail/retry/skip/cancel），`?since=` 支持增量拉取，状态延迟 ≤1s（AC-08）。
- **拓扑分层**：Kahn 算法计算波次，节点启动日志携带"波次 N"，同层并行。

### 与规格文档的一处不一致（已按数据契约处理，请组内知悉）

规格 4.1.1 写明 start 出度 = 1，但 5.2 示例方案与附录 A 分解图中 start 均直接 fan-out 两条出边表达并行。**校验器按数据契约放宽为 start 出度 ≥ 1**（`validator.ts` 内有注释标注）。若组内评审后决定维持 4.1.1，请先改文档再改代码（9.4 变更管理）。

## 团队对接

### 负责人 B（前端 / M2）

- 轮询 `GET /api/runs/:runId?since=<lastSeq>`（500ms），按 `nodeStates[id].status` 着色：
  PENDING 灰 `#d9d9d9` / RUNNING 蓝 `#409eff` / SUCCESS 绿 `#67c23a` / FAILED 红 `#f56c6c` / SKIPPED 黄 `#e6a23c` / CANCELED 深灰 `#909399`。
- 执行失败（40002）响应中的 `details[].nodeId` 直接用于画布红色描边与错误清单定位。
- 保存用 `POST /api/plans`（带 id 更新），加载用 `GET /api/plans` + `GET /api/plans/:id`。
- TaskSpec 字段约定见 `src/types.ts`（`branch` 仅分支绑定条目携带；`expression` 仅 condition；`output` 由分解器注入到条件的前置任务；`wait` 为 delay 的扩展字段）。

### 负责人 D（持久化 / M4）

- 替换 `services/storage.ts`：实现 `PlanService`（save/list/get/delete）与 `RunService`（save/get）两个接口即可，`app.ts`/`routes.ts` 零改动（构造注入）。
- 注意 `runService.save` 在运行期间会被高频调用（每次状态变化），建议保留原子写与写串行化。

### 负责人 E（测试 / M6）

- `npm test` 输出即 8.2 节"关键测试点"的单测证据：分解器 13 例、表达式 15 例、校验器 22 例、执行器 11 例、接口 13 例，共 **74 例全通过**。
- 接口测试覆盖全部错误路径（40001/40002/40003/40401/40402/40901）。

## 示例：分解 → 执行 全链路

```
POST /api/decompose  { text: 附录A规格 }      → 9 个任务（1.1/1.2 并行组、3.1 条件、3.5 end）
POST /api/plans      { 规格 5.2 示例方案 }     → { id: "plan_ab3f9k" }
POST /api/plans/plan_ab3f9k/execute           → { runId: "run_xxx" }
GET  /api/runs/run_xxx                        → n7/n9 SUCCESS、n8 SKIPPED、运行 SUCCESS
```
