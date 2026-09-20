# S54 方案：产出物的「版本历史」与「退回版本」

> 日期：2026-09-20　类型：用户报告（"产出物没有退回版本功能"）　真源：`workspaces-artifacts.md` §3/§4、`prd` FR-07、`ui.md` §5
> 关联：`docs/changes/2026-09-20-s54-artifact-version-rollback.md`、`docs/plan/development.md`
> 用户原话：**"产出物没有退回版本功能"**

## 1 需求与根因

**现场（活体数据 `p_mu9ksdagz3qwc`，4 条产出物全部 v1）**：

| 事实 | 说明 |
| --- | --- |
| 后端**早就有**回退 | `ArtifactService.rollback`、`POST /api/projects/:pid/artifacts/:aid/rollback`、`GET .../versions`、Agent 工具 `artifact_rollback` 全都在，集成测试也覆盖（规则 10） |
| **界面看不到历史版本** | 产出物表的 `dataSource` 来自 `GET /artifacts`，而该接口的口径是**每个 artifact 只回最新版本**（`artifact-store.list` 按 id 取最后一条）。于是界面上一件产出物只有一行，**没有任何地方能看到 v1/v2/v3** |
| 唯一的回退按钮是"撤销最新一版"且**语义说不清** | 表格行上的「回退此版本」把 `record.version`（＝最新版）连同 **`force=true` 硬编码**传下去，实际效果是"撤销最新一版"；`force` 硬编码还意味着**静默覆盖**"该版本之后被改过的文件"（§3 要求先提示冲突） |
| "回退"到底是什么意思，用户看不出来 | 后端语义是"把该版本涉及的文件恢复为**其提交前**内容"（撤销这一版）——对 v1 这类 `action='add'` 的版本就是**把文件删掉**。页面既没有说明，也没有"会发生什么"的预览 |

**结论**：不是后端缺功能，而是**入口缺一半 + 语义缺一层 + 安全提示缺一层**。

## 2 改动

| # | 改动 | 落点 |
| --- | --- | --- |
| ① | **加"退回此版本"（restore）语义** | `rollback` 增 `mode`：`undo`（缺省，历史口径）＝撤销目标版本这一版；**`restore`＝把文件恢复成目标版本的**内容**（＝撤销它之后的所有版本）**。算法：按版本号升序看目标版本之后的每一版，每个 relPath **首次**被改动的那一版的 `base` 就是"目标版本时的内容"（`action='add'` → 删除该文件）。目标已是最新版 → `ERR_VALIDATION`（没有可退回的东西） |
| ② | **修掉"假冲突"** | 冲突拦截原先拿 `latest.files` 当"已知内容"——**最新一版可能根本没碰这个文件**，于是合法回退被误判成冲突。改为"从最新版本往前找第一个碰到该文件的版本"（`delete` 视为应不存在）。这条同时修好了 `undo` 路径的同类误判 |
| ③ | **产出物表加「版本历史」** | 表格行不再直接回退，改为打开弹窗：`GET .../artifacts/:aid/versions`（**倒序**）列出全部版本——版本号（最新一版标「当前」）、状态（已登记／已退回 v{n}／已撤销 v{n}）、提交者、本地时间、变更行数、文件（新增/修改/删除） |
| ④ | **「退回此版本」只对非当前版本可用** + 先出确认 | 确认文案写明"写回 N 个文件、删除 M 个新增文件（列出文件名），结果是 v{n} 的内容，并产生新版本 v{k}；历史版本不会被删除"——把 §3 的"先提示差异与冲突风险"落成看得见的字 |
| ⑤ | **冲突二次确认（去掉硬编码 force）** | 服务端 `ERR_CONFLICT` + `detail.conflicted[]` → 弹出"这些文件在该版本之后被改动过：… 会被覆盖。仍要强制退回吗？"，确认后才带 `force=true` 重试 |
| ⑥ | **记录回退方式** | 版本记录新增 `revertMode`（`undo`/`restore`，非回退版本 `null`，旧数据缺省视为 `undo`）——否则 `revertedTo` 在两种方式下含义不同（被撤销的一版 vs 退回到的一版），界面上会显示成一句会被误读的"已回退→v3" |
| ⑦ | **纯逻辑抽出可测** | 版本行/状态文案、`restorePlan`（文件级预览，与服务端同源）、确认文案、`conflictFiles` 收进 `web/src/lib/artifact-versions.ts`，node 侧单测（仓库既有模式：前端逻辑进 `web/src/lib/`） |

**不改**：`rollback` 的 `undo` 语义与既有调用方（Agent 工具 `artifact_rollback` 仍只做 `undo`）、版本目录结构（`artifact-versions/<id>/v<n>/`）、"不物理删历史"、归属校验与写通道（回退仍走 `WorkdirFs` + 重新署名）、登记免审批（S53/D56）。

## 3 验证方式

| 层 | 手段 |
| --- | --- |
| 单元（服务） | `artifact-service.test.ts` 新增 2 条：① v1 新增、v2 改、v3 新增 → `restore` 到 v1：文件写回 v1 内容、v3 新增的文件被删、新版本 `revertMode='restore'`、历史 4 版都在；最新版本 `restore` → `ERR_VALIDATION` ② 登记后又手工改过 → `restore` 命中 `ERR_CONFLICT`（`detail.conflicted`）+ `force` 覆盖成功；`undo` 记 `revertMode='undo'`。既有规则 10 用例（含"假冲突"路径）保持全绿 |
| 单元（前端纯逻辑） | 新增 `tests/unit/web/artifact-versions.test.ts`（8 条）：降序 + `isCurrent`；`已退回`/`已撤销`/旧数据缺省撤销；**首次命中优先**（v4 又改一次不改变结论）；退回最新版无改动；确认文案含数字/版本号/"历史版本不会被删除"；`conflictFiles` 过滤非字符串 |
| 集成（HTTP） | `work-api.test.ts` 规则 10 扩展：未知 `mode` → 400；`mode=restore` 到 v1 → 200 + 文件内容回来 + `revertMode`；`restore` 到最新版 → 400 |
| 回归 | `npm test` **67 files / 420 tests 全绿**；`coverage` 143/143、`ratchet` 0、`typecheck`/`eslint`/`build` 通过 |
| **活体验证** | 运行中的实例：① `mode=nope` → 400（`allowed:["undo","restore"]`）② `mode=restore` 打最新版 → 400「v1 已经是最新版本，无需退回」（**不触碰任何文件**，可安全复现）③ `GET .../versions` 带上 `revertMode` 字段 |
| **用户点验** | 产出物表出现「版本历史」；有 ≥2 版时可对旧版本点「退回此版本」，确认框列出将写回/删除的文件；退回后列表出现新版本（状态「已退回 v{n}」），工作目录文件内容确实变回该版 |

## 4 风险

| 风险 | 对策 |
| --- | --- |
| "退回"被理解成"删掉后面的版本" | 文案明说"历史版本不会被删除"，并显示新版本号；记录里 `revertMode` 区分"已退回/已撤销" |
| 退回 v1 会删掉文件（v1 是新增） | 确认文案**点名**要删除的文件（"删除 1 个新增文件"），不再是静默 force |
| 误覆盖平台之外的手工改动 | 冲突拦截 + 二次确认（`force` 必须用户点"强制退回"才发）；比对基准改成"该文件已知最新内容"，不放过真正的外部改动 |
| 两个 mode 让人混淆 | 界面只暴露 `restore`（用户语言"退回版本"）；`undo` 留给 Agent 工具与既有脚本，文档写清区别 |
| 大产出物（200 文件）预览慢 | `restorePlan` 只吃已加载的版本记录（一次 `versions` 请求），纯数组计算，不发额外请求 |
