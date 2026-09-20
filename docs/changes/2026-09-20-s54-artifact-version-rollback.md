# 修改记录 · S54 产出物的「版本历史」与「退回版本」

> ⚠️ **已被 S56 撤销**：本次交付的「版本历史」与「退回此版本」已按用户要求删除（"产出物的历史版本功能删除"），当前行为以 [S56 记录](2026-09-20-s56-remove-artifact-history.md) 与 [`workspaces-artifacts.md`](../design/workspaces-artifacts.md) §3/§4/§5 为准。本文保留为当时的改动记录。

> 类别：changes · 日期：2026-09-20 · 关联方案：[docs/plan/2026-09-20-s54-artifact-version-rollback.md](../plan/2026-09-20-s54-artifact-version-rollback.md)
> 关联设计：[workspaces-artifacts.md](../design/workspaces-artifacts.md) §3/§4/§5/§7、[ui.md](../design/ui.md) §5、[data-storage.md](../design/data-storage.md) §6、[contract.md](../api/contract.md)、[prd](../requirements/prd.md) FR-07 / D58

## 1. 需求 / 问题

用户报告：**"产出物没有退回版本功能"**。

现场（活体数据 `p_mu9ksdagz3qwc`，4 条产出物全部 v1）：

- **后端不缺**：`ArtifactService.rollback`、`POST .../artifacts/:aid/rollback`、`GET .../artifacts/:aid/versions`、Agent 工具 `artifact_rollback` 都在，集成测试也覆盖（规则 10）。
- **界面缺一半**：产出物表的数据来自 `GET /artifacts`，而该接口**每个 artifact 只回最新版本**（`artifact-store.list` 按 id 取最后一条）⇒ 界面上**永远看不到 v1/v2/v3**，"退回某个版本"这件事在 UI 上不存在入口。
- **唯一的按钮语义说不清、且静默覆盖**：表格行上的「回退此版本」把 `record.version`（＝最新版）连同**硬编码 `force=true`** 传下去，实际效果是"撤销最新一版"，而且**不提示冲突**（违反 §3"先提示差异与冲突风险，不静默覆盖"）。
- **"回退"的含义没有交代**：后端语义是"把该版本涉及的文件恢复为**其提交前**内容"——对 v1 这类 `action='add'` 的版本就是**把文件删掉**；页面既没说明，也没有"会发生什么"的预览。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| ports | `src/ports/artifact.ts` | `rollback` 增 `mode?: 'undo' \| 'restore'`；`ArtifactRecord` 增 `revertMode?`（`undo`\|`restore`\|`null`，旧数据缺省 `undo`） |
| application | `src/application/artifact/artifact-service.ts` | `rollback` 支持两种方式（`undo`＝目标版 base；`restore`＝目标版之后每个文件**首次**被改动那一版的 base，`add` → 删除）；`restore` 到最新版 → `ERR_VALIDATION`；**修掉"假冲突"**：比对基准改为"从最新版本往前找第一个碰到该文件的版本"（`delete` 视为应不存在），不再拿 `latest.files` 当基准；新版本记录写 `revertMode` |
| infra | `src/infra/file-store/artifact-store.ts` | 读取时解析 `revertMode`（缺省 `undo`、非回退版本 `null`） |
| server | `src/server/http-routes/work.ts` | `POST .../rollback` 接受 `mode`（未知值 400 + `allowed`），缺省 `undo`（向后兼容既有调用） |
| web | `web/src/api/work.ts` | `rollback(pid, aid, version, {mode, force})`；`ArtifactRecord.revertMode`；导出 `ArtifactRollbackMode` |
| web | `web/src/lib/artifact-versions.ts`（新） | 纯逻辑：`versionRows`（倒序 + `isCurrent` + 状态文案）、`rollbackModeText`/`rollbackTone`、`restorePlan`（文件级预览，与服务端同源）、`rollbackConfirmText`、`conflictFiles`、`actionText` |
| web | `web/src/pages/WorkPanel.tsx` | 产出物表：状态列改用 `rollbackModeText`（区分「已退回 v{n}」/「已撤销 v{n}」）；行操作从"硬编码 force 的回退按钮"换成**「版本历史」**；新增版本历史弹窗（全部版本 + 非当前版本可**「退回此版本」**，确认文案写明写回/删除的文件数与新版本号）；`ERR_CONFLICT` → 二次确认后带 `force` 重试 |
| tests | `tests/unit/application/artifact-service.test.ts`（+2）、`tests/unit/web/artifact-versions.test.ts`（新 8）、`tests/integration/server/work-api.test.ts`（+3 断言组） | 见 §4 |
| docs | `prd`（**D58** + FR-07 补注）、`workspaces-artifacts.md` §3/§4/§5/§7、`ui.md` §5、`data-storage.md` §6、`contract.md`、`README.md`、`plan/development.md`、`testing/plan.md`（规则 10）、验收阶段清单加 `s54` | 全链路回写 |

**未改**：`undo` 的语义与既有调用方（Agent 工具 `artifact_rollback` 仍只做 `undo`，描述不动）；版本目录结构 `artifact-versions/<id>/v<n>/`；"不物理删历史"；归属校验与写通道（回退仍经 `WorkdirFs` 并重新署名）；登记免审批（S53/D56）。

## 3. 关键决定

1. **"退回版本"要有"回到那一版内容"的语义**：既有 `rollback` 是"撤销这一版"（恢复到它的**提交前**）。用户在界面上说"退回 v2"，期待的是"文件变回 v2 的样子"。两者对"最新版"附近是等价的（撤销 v3 ≈ 回到 v2），但对更早的版本、以及"v2 之后又新增过别的文件"的情形并不等价。所以 `restore` 按"目标版本之后最早改动每个文件的那一版取 base"来算，一次调用、一条新版本记录。
2. **两种方式共用一个 `rollback` + `mode`**：文件写回、版本记录、署名、冲突拦截全部复用同一条代码路径，避免出现第二个"回退"。`mode` 缺省 `undo` ⇒ 既有脚本/测试/Agent 工具行为不变。
3. **冲突拦截的基准必须是"文件已知最新内容"，不是"最新一版的文件清单"**：实体 bug——最新一版可能没碰这个文件，那时按 `latest.files` 找不到哈希，任何内容都会被判成冲突（活体项目里 v3 只登记了 `docs/ux.md`，退回 v1 就因此假冲突）。改为从最新版本往前找第一个碰到该文件的版本；`delete` 视为"应不存在"。
4. **记录 `revertMode`**：`revertedTo` 在两种方式下含义不同（被撤销的一版 / 退回到的一版），不记方式的话界面上那句「已回退→v3」会被读成"回到了 v3"，而实际是"撤销了 v3"。一个可选字段就能消掉这个歧义（旧数据缺省 `undo`）。
5. **确认文案先讲清楚后果**：退回可能**删除文件**（目标版本之后新增的那些）。确认框点名"写回 N 个、删除 M 个（文件名）"，冲突时再单独确认一次——把 §3 的"不静默覆盖"落到交互上。
6. **界面对用户只暴露 `restore`**：对用户来说"撤销某一版"就是"退回它前面那一版"，两个按钮只会让人选错；`undo` 留给 Agent 工具与既有 API。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 新增单测（服务） | `artifact-service.test.ts` **+2 passed**：① v1 新增、v2 改、v3 新增 → `restore` 到 v1：`docs/prd.md` 回到 v1 内容 `A`、v3 新增的 `docs/ux.md` 被删除、新版本 `{version:4, state:'reverted', revertedTo:1, revertMode:'restore'}`、历史 4 版都在；`restore` 到最新版 → `ERR_VALIDATION` ② 登记后又手工改过 → `restore` 命中 `ERR_CONFLICT`（`detail.conflicted=['docs/prd.md']`）+ `force` 覆盖成功；随后 `undo` → `revertMode='undo'`、内容回到该版 base |
| 既有用例回归 | 规则 10（`undo` 恢复 base / 冲突拦截 / force 覆盖）在**改了冲突基准后仍然全绿**——说明新基准对历史口径是等价的（旧的"假冲突"路径不在该用例覆盖范围内） |
| 新增单测（前端纯逻辑） | `tests/unit/web/artifact-versions.test.ts` **8 passed**：降序 + `isCurrent`；「已登记 / 已退回 v1 / 已撤销 v2 / 旧数据缺省撤销」；文件动作文案；`restorePlan` 的**首次命中优先**（v4 又改一次 prd 不改变结论）；退回 v2/最新版的计划；确认文案含"写回 1 个文件 / 删除 1 个新增文件 / v1 的内容 / 新版本 v4 / 历史版本不会被删除"；`conflictFiles` 过滤非字符串 |
| 集成（HTTP） | `work-api.test.ts` 规则 10 扩展：`mode:'nope'` → 400；`mode:'restore'` 到 v1 → 200 + `revertMode:'restore'` + **v2 删掉的 `docs/prd.md` 被写回**（`readFileSync` 含 `目标`）；`restore` 到 v3（最新）→ 400；版本序列 `[1,2,3]` |
| 全量测试 | `npm test` **67 files / 420 tests 全绿**（S53 后为 66/410） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **143/143**；`npm run ratchet` 违规 **0** |
| typecheck / eslint | 0 错误（src + web；其间修掉 `historyRows[0]` 在 `noUncheckedIndexedAccess` 下的可能 undefined） |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-BiB_K3VW.js`（1,381.56 kB / gzip 432.65 kB） |
| **活体验证**（运行中的实例，`tsx watch` 重启后） | ① `mode:'nope'` → **400** `ERR_VALIDATION`「未知回退方式：nope」+ `allowed:["undo","restore"]` ② `mode:'restore'` 打**最新版** → **400**「v1 已经是最新版本，无需退回」（**不触碰任何文件**，可安全复现）③ `GET .../versions` 返回带 `revertMode` 字段（未回退版本为 `null`） |
| **未覆盖** | 弹窗交互与真实退回后的文件内容无法在本机自动化：**须用户点验** —— 产出物表出现「版本历史」；对旧版本点「退回此版本」时确认框列出将写回/删除的文件；退回后列表出现新版本（「已退回 v{n}」）且工作目录文件内容确实变回该版 |
| 说明 | 与 S15~S53 的交付口径一致 |

## 5. 遗留

- **只能整版回退**：不能只回退某个文件里的某一处改动，也不能"把某几个文件退回 v2、另几个留在 v3"。要做的话需要"按 relPath 选择目标版本"的接口（本轮未做）。
- **`restore` 会删除"目标版本之后新增"的文件**：确认框已点名，但不会自动备份到工作目录之外（版本快照仍在 `artifact-versions/`，可再退回回来）。
- **Agent 侧只有 `undo`**：`artifact_rollback` 工具仍只支持"撤销自己提交的那一版"。若要让 Agent 也能"退回到某一版"，给工具加 `mode` 参数即可（未做，避免扩大工具面）。
- **版本链的命名口径**：同一个 artifact 的后续版本要求"同提交者 + 同类型 + 同标题 + 同任务"（D14-⑧）。活体项目里 PRD v0.1 → v1.0 因为标题不同而成了**两条 artifact**（各自 v1）——"版本历史"因此对它们显示不出 v2。若希望"同一份文档的所有版本聚在一起"，需要改聚合键（跨标题/跨任务归并），属独立一轮。
- **回退本身没有审批门**：用户操作直接生效（以提交者身份代行）。Agent 侧受"只能回退自己"限制；若将来要"回退他人产出物需提交者同意"，需走审批（未做）。
