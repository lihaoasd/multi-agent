# S56 方案：删除产出物「版本历史」功能（撤销 S54）

> 日期：2026-09-20　类型：用户口径（"产出物的历史版本功能删除"）　真源：`workspaces-artifacts.md` §3/§4/§5/§7、`ui.md` §5
> 关联：`docs/changes/2026-09-20-s56-remove-artifact-history.md`、`docs/plan/development.md`
> 用户原话：**"产出物的历史版本功能删除"**

## 1 需求

S54（同日）按上一条口径"产出物没有退回版本功能"做了「版本历史」弹窗 + 「退回此版本」（`rollback` 的 `mode=restore` + 版本记录的 `revertMode`）。用户看过后要求**删除该功能**。

## 2 删除范围

| # | 删除 | 落点 |
| --- | --- | --- |
| ① | **界面**：产出物表的「版本历史」按钮、版本历史弹窗、「退回此版本」动作、版本状态专用文案 | `web/src/pages/WorkPanel.tsx`（产出物表回到只读：标题/类型/版本/提交者/变更/文件/状态） |
| ② | **纯逻辑与其单测** | 删 `web/src/lib/artifact-versions.ts`、`tests/unit/web/artifact-versions.test.ts` |
| ③ | **`mode='restore'` 语义** | `src/application/artifact/artifact-service.ts`（`rollback` 回到单一语义＝撤销目标版本这一版）、`src/ports/artifact.ts`（去掉 `ArtifactRollbackMode` 与 `mode` 参数） |
| ④ | **`revertMode` 字段** | `src/ports/artifact.ts`、`src/infra/file-store/artifact-store.ts`（读取解析）、`web/src/api/work.ts`（类型） |
| ⑤ | **路由参数** | `src/server/http-routes/work.ts`（`POST .../rollback` 回到 `{version, force?}`） |
| ⑥ | **相关单测/集成断言** | 删 S54 的两条服务用例与三组 HTTP 断言（含未知 `mode` 400、`restore` 到最新版 400 等） |

## 3 保留

| 保留 | 说明 |
| --- | --- |
| `GET .../artifacts/:aid/versions`、`POST .../rollback` 接口 | 契约与实现都在（Agent 工具/脚本可用），只是界面不提供入口 |
| Agent 工具 `artifact_rollback` | 语义本来就是"撤销自己提交的那一版"，不受影响 |
| 版本目录、署名、`state=reverted` + `revertedTo`、"不物理删历史" | 回退的记录方式不变 |
| **一处与历史版本无关的修正** | 回退的**冲突判定基准**仍是"平台已知的该文件最新内容"（从最新版本往前找第一个碰到该文件的版本；`delete` 视为应不存在）。旧逻辑取 `latest.files`，"最新一版没碰这个文件"时会把合法回退误判成冲突——该缺陷属于 `rollback` 本身，与 S54 的界面无关，故**不回退**，并把用例改写成 undo 口径的回归测试 |

## 4 验证方式

| 层 | 手段 |
| --- | --- |
| 单元（服务） | `artifact-service.test.ts`：删掉 S54 的两条；新增 1 条 undo 口径的假冲突回归——v1 新增 prd、v2 改 prd、v3 只新增 ux，**撤销 v2 必须成功**（旧基准会误报冲突），随后对"平台之外的手工改动"仍报 `ERR_CONFLICT`（`force` 可覆盖） |
| 集成（HTTP） | `work-api.test.ts` 规则 10 回到 `{version, force?}` 与"回退即删除新增文件"的断言；S54 的 `mode` 断言全部删除 |
| 界面 | 产出物表不再有「版本历史」按钮与弹窗（`WorkPanel` 中不存在 `artifact-versions` 引用）；`web/src/lib/artifact-versions.ts` 已删 |
| 回归 | `npm test` / `coverage` 143/143 / `ratchet` 0 / `typecheck` / `eslint` / `build` 全绿 |
| **用户点验** | 「任务与产出物」里产出物表**只剩展示**（无「版本历史」、无「退回此版本」）；任务表的状态改法（S55）不受影响 |

## 5 风险

| 风险 | 对策 |
| --- | --- |
| 界面删除后有人以为"回退能力没了" | 接口与 Agent 工具保留；`workspaces-artifacts.md` §3/§4/§5 明确写"无 UI 入口、接口/工具可用"（回到 2026-09-09 的原始口径） |
| 删掉 `mode` 影响既有调用 | `mode` 是 S54 当天新增、只有该界面在用；缺省即 undo，删除后请求体回到 `{version, force?}`，与 S53 之前的调用方一致 |
| 误删冲突基准修正（真缺陷回潮） | 保留该修正并单独留一条回归用例钉住 |
