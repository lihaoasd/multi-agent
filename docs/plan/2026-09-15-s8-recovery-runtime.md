# 开发方案 · S8 恢复、运行控制与收口

> 类别：plan · 状态：已完成（2026-09-15）· 类型：**实现** · 总计划：[development.md](development.md) §6 · 执行结果见 [修改记录](../changes/2026-09-15-s8-recovery-runtime.md)
> 关联：[agent-runtime.md](../design/agent-runtime.md) §7、[sessions.md](../design/sessions.md)、[ui.md](../design/ui.md) §4/§5、[contract.md](../api/contract.md)、[data-storage.md](../design/data-storage.md) §9

## 1. 目标与范围

把"中断后能收场、运行中能刹车、数据能带走"补上：**跨重启的未完成回合**给用户三选（不自动续跑）、**停止生成/停止任务**（停止任务先结算快照）、顶部**运行细条**（n 个 Agent 正在工作 + 队列 + 暂停），以及**项目导出 zip**。

| 在范围内 | 不在范围内（后续阶段） |
| --- | --- |
| 未完成回合判定（缺 `turn_end`）+ 三选（汇报中断点/继续执行/忽略）+ 半截回复补全 | 富文本/二进制产出的预览（FR-16，P1） |
| `stop`：`scope=turn`（停当前回合输出、队列保留）/ `scope=task`（终止当前任务，先结算 code artifact） | 托盘批量审批与信任开关（P1/S9 之后） |
| `GET /api/projects/:pid/runtime`（细条数据）+ 前端 `WorkingBar` | 多进程/多实例部署下的停止语义 |
| 项目导出 zip（零依赖 STORE 写入器）+ 导出按钮 | 导入/恢复向导 |
| 启动自检：清理遗留占用 + 记录未完成回合（不自动续跑） | 未完成回合的自动续跑（设计明确禁止，D16-③） |

## 2. 关键决定

1. **判定唯一依据是"缺 `turn_end`"**：`RecoveryService` 按事件顺序用**栈**配对 `turn_start`/`turn_end`；即使回合号被复用（`runtime.state.json` 丢失后从 1 重新计数），较早那个未闭合的回合仍能被判定出来。返回**最早**的未完成回合。
2. **绝不自动续跑**：`resolve` 只落一条 `state` 标记（`{unfinishedTurn, recovery}`）+ 按动作注入一条系统消息唤醒一轮；`ignore` 不唤醒。重复处理同一回合 → `ERR_CONFLICT`。启动自检只记日志。
3. **停止分两层**：`turn`（"停止生成"）= `dispatcher.abortTurn`（可中断点收尾、游标不推进 → 消息仍在队列）；`task` = 先 `abortTurn`，再 `TaskService.setState(terminated)`（**先结算未结算改动**为可回退 code artifact）并回报 `settledArtifactId`。
4. **细条数据来自真相单轨**：占用者取 `runtime.state.json` 的 occupancy（唯一真相），叠加实时 `state/turn/startedAt`、当前 `in_progress` 任务标题、最近 `plan` 事件状态与未完成回合号；`working` 只列非 idle 的 Agent。
5. **零依赖 zip**：自研 STORE 方式 ZIP 写入器（本地文件头 + 中央目录 + EOCD，UTF-8 名称 + CRC32），不引入压缩依赖；导出**只含运行时项目文件夹**（会话/记忆/产出物/归属/任务/询问/编排图），**不含用户工作目录**（与 prd FR-01 口径一致），并在包里放一份 `EXPORT-README.txt` 说明范围。
6. **导出体积护栏**：默认 64M 字符上限，超限返回 `ERR_VALIDATION`（避免把进程内存打满）。

## 3. 交付物

| 步骤 | 交付物 |
| --- | --- |
| S8.1 端口 | `ports/runtime.ts`（RecoveryService / RuntimeService / UnfinishedTurn / ProjectExporter / ArchiveWriter）；`ports/dispatcher.ts` 增 `abortTurn` |
| S8.2 infra | `infra/archive/zip.ts`（STORE ZIP 写入器）；`dispatcher` 实现 `abortTurn` |
| S8.3 application | `application/recovery/recovery-service.ts`、`application/runtime/{runtime-service,exporter}.ts` |
| S8.4 server | `http-routes/runtime.ts`（runtime/recovery/stop/export）+ `app.ts` 接入 |
| S8.5 装配 | `composition-root.ts`：Recovery/Runtime/Exporter 装配（复用 `notify` 唤醒通道）；`main.ts` 启动自检记录未完成回合 |
| S8.6 前端 | `api/runtime.ts`、`pages/{WorkingBar,RecoveryBanner}.tsx`、`SessionPanel`（横幅 + 停止生成）、`ProjectModule`（细条 + 导出按钮） |
| S8.7 测试 | `unit/application/runtime-recovery`(10)、`integration/server/runtime-api`(6) = 16 条（规则 14/19/20 + 导出） |

## 4. 验证方式与结果

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| 类型检查 / 门禁 | `typecheck` / `lint` / `ratchet` / `build` | 0 错误 / exit 0 / 越层违规 0 / vite 构建成功 |
| 测试 | `npm run test` | **43 files / 294 tests 全通过**（S8 新增 2 文件 16 条） |
| 规则 19 未完成回合 | 演示 + 用例 + HTTP | `u_dev_1#turn1`（plan-execute，plan 3 步/running）被判定；三选 `report` → `resumed=true` 且落 `state` 标记 + 注入系统消息；重复处理 → **409 ERR_CONFLICT**；`ignore` 不唤醒；完整回合（含 `turn_end`）不被判定 |
| 规则 14 不自动续跑 | 用例 + HTTP | 缺 `turn_end` 的回合只提供三选数据（`resolvedBy` 为 null 时才提示），`turn` 不匹配 → `ERR_CONFLICT`；启动自检只记日志 |
| 规则 20 停止 | 演示 + 用例 + HTTP | `scope=turn` → `{aborted, queued}` 且不动任务；`scope=task` → 终止任务 + `settledArtifactId`（`type=code`，可回退）；非法 scope → 400 |
| 规则 20 细条 | 演示 + 用例 + HTTP | 占用者才进 `working`（含 turn/startedAt/任务标题/plan 状态/未完成回合/队列），idle 与 paused 单独计数 |
| 项目导出 | 演示 + 用例 + HTTP | `application/zip` + `attachment; filename="<pid>.zip"`；PK 头正确、含 `EXPORT-README.txt` 与 `sessions/u_dev_1.log.jsonl`、**不含**工作目录文件；不存在项目 → 404 |

## 5. 不做与遗留

- 未做：导入/恢复向导、导出增量、托盘批量审批与信任开关、富文本/二进制产出预览（P1）。
- 停止的进程内语义：`abortTurn` 只对**本进程**的活动回合生效（跨进程/多实例部署需共享状态，见 data-storage 迁移说明）。
- 导出的 zip 不压缩（STORE）：体积换零依赖，日志很大时可再引入流式压缩。
