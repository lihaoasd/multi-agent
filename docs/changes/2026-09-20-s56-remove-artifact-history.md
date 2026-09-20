# 修改记录 · S56 删除产出物「版本历史」功能

> 类别：changes · 日期：2026-09-20 · 关联方案：[docs/plan/2026-09-20-s56-remove-artifact-history.md](../plan/2026-09-20-s56-remove-artifact-history.md)
> 关联设计：[workspaces-artifacts.md](../design/workspaces-artifacts.md) §3/§4/§5/§7、[ui.md](../design/ui.md) §5、[data-storage.md](../design/data-storage.md) §6、[contract.md](../api/contract.md)、[prd](../requirements/prd.md) FR-07 / D60（撤销 D58）

## 1. 需求

用户口径：**"产出物的历史版本功能删除"**。

S54（同日）按上一条口径"产出物没有退回版本功能"实现了「版本历史」弹窗 + 「退回此版本」（`rollback` 的 `mode=restore` + 版本记录 `revertMode`）。用户看过后要求删除。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/WorkPanel.tsx` | 删除产出物表的「版本历史」按钮、版本历史弹窗、「退回此版本」动作、版本状态专用文案（`rollbackModeText`/`rollbackTone`）与相关 state/handler；产出物表回到**只读**（标题/类型/版本/提交者/变更/文件/状态） |
| web | 删 `web/src/lib/artifact-versions.ts` | S54 的纯逻辑（`versionRows`/`restorePlan`/`rollbackConfirmText`/`conflictFiles` 等）与其 8 条单测一并移除 |
| web | `web/src/api/work.ts` | `ArtifactRecord.revertMode`、`ArtifactRollbackMode` 删除；`rollback(pid, aid, version, force)` 回到原签名 |
| application | `src/application/artifact/artifact-service.ts` | `rollback` 去掉 `mode='restore'` 分支与 restore 计划组装、去掉记录里的 `revertMode`；**保留**冲突判定基准修正（见 §3） |
| ports | `src/ports/artifact.ts` | 删 `ArtifactRollbackMode`、`ArtifactRecord.revertMode`、`rollback` 的 `mode` 参数 |
| infra | `src/infra/file-store/artifact-store.ts` | 删 `revertMode` 的读取解析 |
| server | `src/server/http-routes/work.ts` | `POST .../rollback` 回到 `{version, force?}`（删 `mode` 校验与透传） |
| tests | `tests/unit/application/artifact-service.test.ts`、`tests/integration/server/work-api.test.ts`、删 `tests/unit/web/artifact-versions.test.ts` | S54 的 restore 用例与 `mode` 断言全部移除；新增 1 条 undo 口径的假冲突回归 |
| docs | `prd`（**D60** + 标记 D58 已被删除 + FR-07 补注改写 + 头部增补）、`workspaces-artifacts.md` §3/§4/§5/§7、`ui.md` §5、`data-storage.md` §6、`contract.md`、`README.md`、`plan/development.md`、`testing/plan.md`（规则 10 / S54 行标注 / 新增 S56 行）、验收阶段清单加 `s56`；S54 的方案与记录文档顶部加"已被 S56 撤销"提示 | 全链路回写 |

## 3. 保留（重要）

| 保留项 | 说明 |
| --- | --- |
| `GET .../artifacts/:aid/versions`、`POST .../rollback` | 接口与实现都在（Agent 工具/脚本可用），只是**界面不再提供入口** |
| Agent 工具 `artifact_rollback` | 语义一直是"撤销自己提交的那一版"，未受影响、描述未改 |
| `state=reverted` + `revertedTo`、版本目录、署名、"不物理删历史" | 回退的落盘方式与审计口径不变 |
| **冲突判定基准修正** | 回退的冲突比对基准仍是"**平台已知的该文件最新内容**"（从最新版本往前找第一个碰到该文件的版本；`delete` 视为应不存在）。旧逻辑取 `latest.files`，**最新一版没碰某个文件**时会把合法回退误判成冲突——该缺陷属于 `rollback` 本身（对 undo 路径同样成立），与 S54 的界面无关，故**不回退**，并把它改写成 undo 口径的回归用例钉住 |

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 删除面 | `web/src/lib/artifact-versions.ts` 与其单测已删；`WorkPanel` 不再引用 `artifact-versions`；`revertMode`/`mode` 在 `src/`、`web/src/` 中已无残留（`grep` 复核，仅历史 docs 提到） |
| 新增单测（服务） | 1 条回归：v1 新增 prd、v2 改 prd、v3 只新增 ux → **撤销 v2 成功**（旧基准会误报冲突）且 `docs/prd.md` 回到 `A`、v3 新增的 `docs/ux.md` 不受影响；随后"平台之外的手工改动"仍被拦（`ERR_CONFLICT` + `detail.conflicted=['docs/ux.md']`，`force` 可覆盖） |
| 集成（HTTP） | 规则 10 回到 `{version, force?}`：回退 v1 → 200 + `state=reverted` + 文件被删除（v1 是 add）；`versions` 状态序列 `['approved','reverted']`；S54 的 `mode` 断言全部删除 |
| 全量测试 | `npm test` **67 files / 417 tests 全绿**（S55 后为 68/426：删 1 文件 8 条 + 服务 2 条，新增 1 条） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **143/143**；`npm run ratchet` 违规 **0** |
| typecheck / eslint | 0 错误（src + web；其间修掉删代码后残留的重复 import） |
| 构建 | `npm run build` 通过 |
| **未覆盖** | 界面观感无法在本机自动化：**须用户点验** —— 「任务与产出物」的产出物表只剩展示列，没有「版本历史」与「退回此版本」；任务表的状态改法（S55）不受影响 |
| 说明 | 与 S15~S55 的交付口径一致 |

## 5. 遗留

- **回退能力仍在但没有界面入口**：要用只能由 Agent（`artifact_rollback`）或直接调 API。若将来还想给用户一个入口，建议做成"一眼能懂 + 默认安全"的单按钮（例如"撤销最新一版"，冲突时必确认），而不是版本列表。
- **`docs/plan|changes/2026-09-20-s54-*.md` 保留但已标注撤销**：按"文档是当前真相源"的原则，S54 的方案/记录不再代表当前行为，阅读时以 S56 与 `workspaces-artifacts.md` §3/§4/§5 为准。
- **版本记录里的历史 `revertMode` 字段**：S54 当天产生的数据里可能有该字段（本机活体项目没有回退记录，实测 `versions` 全为 `null`/无该字段），读取端已不再解析——字段留在 JSONL 里无害（append-only，不做数据迁移）。
