# 修改记录 · S8 恢复、运行控制与收口

> 类别：changes · 日期：2026-09-15 · 关联方案：[docs/plan/2026-09-15-s8-recovery-runtime.md](../plan/2026-09-15-s8-recovery-runtime.md) · 总计划：[development.md](../plan/development.md) §6
> 关联设计：[agent-runtime.md](../design/agent-runtime.md) §7、[ui.md](../design/ui.md) §4/§5、[contract.md](../api/contract.md) §系统

## 1. 需求 / 问题

S7 结束时"编排能改、任务能派"，但**中断之后无法收场**：缺 `turn_end` 的回合没有判定与三选入口，用户无法"汇报中断点/继续执行/忽略"（规则 19）；**运行中无法刹车**（没有"停止生成"，也没有"停止任务并结算快照"）；顶部**没有"n 个 Agent 正在工作"细条**（规则 20）；**项目数据无法带走**（导出 zip 只有契约没有实现）。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| ports | `ports/runtime.ts`（新增）、`ports/dispatcher.ts` | 恢复/运行控制/导出端口（含 `UnfinishedTurn`/`RuntimeSnapshot`/`ArchiveWriter`/`ProjectExporter`）；Dispatcher 增 `abortTurn` |
| infra | `infra/archive/zip.ts`（新增）、`application/dispatcher/dispatcher.ts` | 零依赖 STORE ZIP 写入器（CRC32 + 本地头/中央目录/EOCD）；`abortTurn` 实现（中断可中断点、游标不推进） |
| application | `application/recovery/recovery-service.ts`、`application/runtime/{runtime-service,exporter}.ts`（新增） | 未完成回合栈式配对判定 + 三选落标记/唤醒；运行细条与 `stop(turn/task)`；项目导出（含体积护栏） |
| server | `server/http-routes/runtime.ts`（新增）、`server/app.ts` | `GET /runtime`、`POST .../agents/:iid/stop`、`GET|POST .../recovery`、`GET .../sessions/:sid/recovery`、`GET .../export` |
| bootstrap | `bootstrap/{composition-root,main}.ts` | 三个服务装配（复用 notify 唤醒通道）；启动自检记录未完成回合（不自动续跑） |
| web | `web/src/api/runtime.ts`、`web/src/pages/{WorkingBar,RecoveryBanner}.tsx`（新增）、`web/src/pages/{SessionPanel,ProjectModule}.tsx` | 顶部运行细条（停止生成/停止任务）、未完成回合横幅（三选 + 补全）、会话头停止生成、项目页导出按钮 |
| docs | `docs/api/contract.md`、`docs/design/{agent-runtime,data-storage}.md`、`docs/plan/development.md` | 契约与设计回写 |
| tests | 2 个新文件 16 条 | 规则 14/19/20 + 导出 |

## 3. 关键决定

1. **栈式配对判定未完成回合**：按事件顺序把 `turn_start` 入栈、`turn_end` 关闭"最近的同号回合"，因此回合号被复用（`runtime.state.json` 丢失后从 1 重数）时仍能认出较早的未闭合回合；对外返回**最早**的那个。
2. **恢复只给选择、不自动续跑**：`resolve` 落 `state` 标记（`unfinishedTurn`+`recovery`）并按动作注入系统消息唤醒一轮；`ignore` 只落标记；重复处理 → `ERR_CONFLICT`。
3. **停止分两层**：`turn`=停止生成（`abortTurn`，游标不推进 → 队列保留）；`task`=先 `abortTurn` 再终止任务（`TaskService` 内部**先结算**未结算改动为 `type=code` artifact，返回 `settledArtifactId`）。
4. **细条取自真相单轨**：占用来自 `runtime.state.json` 的 occupancy，叠加实时状态、当前任务标题、最近 `plan` 状态与未完成回合号；只列非 idle。
5. **零依赖 zip（STORE）**：自研写入器避免新增压缩依赖；导出只含运行时项目文件夹、附 `EXPORT-README.txt` 说明范围、不含用户工作目录；体积超 64M 字符 → `ERR_VALIDATION`。

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 类型检查 | `npm run typecheck` 0 错误 |
| 测试 | **43 files / 294 tests 全通过**（S8 新增 2 文件 16 条） |
| 门禁 | `npm run lint` exit 0；`npm run ratchet` 越层违规 0；`npm run build` 成功 |
| 规则 19 | 演示：`u_dev_1#turn1`（plan-execute，plan 3 步/running）判定成功；`report` → `resumed=true`，落 `state` 标记 + 系统消息；重复 → `ERR_CONFLICT`；`ignore` 不唤醒；HTTP 实测 `/recovery` 返回 `resolvedBy=report` |
| 规则 14 | 用例：完整回合（含 `turn_end`）不判定；`turn` 不匹配 → `ERR_CONFLICT`；启动自检只记日志（不续跑） |
| 规则 20 停止 | 演示：`scope=turn` → `aborted=false/queued=0`（无活动回合时如实返回）；`scope=task` → `taskId=t_…` + `settledArtifactId=a_…`，任务终态 `terminated`；HTTP 非法 scope → 400 |
| 规则 20 细条 | 演示/HTTP：`/runtime` 返回 `working/idle/paused/queuedTotal`；用例覆盖占用者的 turn/startedAt/任务标题/plan 状态/未完成回合/队列 |
| 导出 | 演示：`p_….zip` 27188 字节、PK 头、含 README 与会话日志、**不含**工作目录文件；HTTP 头 `application/zip` + `attachment; filename="<pid>.zip"`；不存在项目 → 404 |
| 文档 | contract/runtime 端点组、agent-runtime §7、data-storage §9 已回写；plan + changes 已落盘 |

## 5. 未做 / 回滚

- 未做（留 S9）：导入/恢复向导、导出增量与流式压缩、托盘批量审批与信任开关、富文本/二进制产出预览（P1）；多进程部署下的停止语义（当前 `abortTurn` 只对本进程活动回合生效）。
- 回滚：删除 `src/ports/runtime.ts`、`src/infra/archive/`、`src/application/{recovery,runtime}/`、`src/server/http-routes/runtime.ts`、`web/src/api/runtime.ts`、`web/src/pages/{WorkingBar,RecoveryBanner}.tsx` 与两个测试文件；还原 `dispatcher`（去掉 `abortTurn`）、`app`/`main`/`composition-root`/`SessionPanel`/`ProjectModule` 的改动；数据侧无需迁移（恢复标记是 `state` 事件，导出是只读）。
