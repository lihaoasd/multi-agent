# 修改记录 · S29「提示词预览」点击无反应的缺陷修复

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s29-preview-modal-branch.md](../plan/2026-09-16-s29-preview-modal-branch.md)
> 关联设计：[ui.md](../design/ui.md) §2.2/§3

## 1. 现象 / 根因

用户报告：**"提示词预览，点击没反应"**。

**根因**：`web/src/pages/ProjectModule.tsx` 有两个互斥的顶层 `return`——项目**详情**页（`if (current !== null) { return … }`）与项目**列表**页。而**预览弹窗的 JSX 只写在列表分支里**：

```
详情分支（current !== null）
  └ 团队与配置表格 → 「提示词预览」按钮  ← 触发入口在这里
列表分支
  └ <Modal open={preview !== null} …>     ← 弹窗却挂在这里（详情页根本不渲染这棵树）
```

所以详情页点击时：`showPreview()` → 接口**成功** → `setPreview(view)` → **没有组件消费该 state** → 界面毫无变化。迷惑点在于**接口没报错、状态也变了**，只是"渲染它的那棵树"不在当前分支。

## 2. 改动范围（仅前端 + 文档）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/ProjectModule.tsx` | 把预览弹窗抽成局部组件 **`PromptPreviewModal({ preview, onClose })`**（原 JSX 原样搬入，`open={preview !== null}`、`footer=null`、宽度 760、`preview === null` 时不渲染内容）；**详情分支**（`</Drawer>` 后）与**列表分支**（创建向导 Modal 前）**各挂一次**；删除原列表分支里的内联弹窗 |
| docs | `docs/plan/2026-09-16-s29-preview-modal-branch.md`、`docs/changes/2026-09-16-s29-preview-modal-branch.md` | 本方案与记录（含同类缺陷判别方法） |
| docs | `docs/README.md`、`docs/plan/development.md`、`docs/testing/plan.md`、验收阶段清单 | 阶段索引与验收记录增 S29、清单加 `s29` |

**未改**：后端 `GET /api/projects/:pid/agents/:iid/system-prompt` 与 `promptPreviewApi`；弹窗内容与交互；列表页行为；其它页面（已审计，见 §3）。

## 3. 同类风险审计

顺带把"浮层是否挂在能触发它的那棵树里"查了一遍：

| 页面 | 结论 |
| --- | --- |
| `ProjectModule` 详情分支 | `Drawer`（覆盖配置）在详情分支 ✓；`PromptPreviewModal` **本轮补上** ✓ |
| `ProjectModule` 列表分支 | 创建向导 `Modal`、`DirectoryPicker` 在列表分支 ✓（入口也在列表） |
| `AgentModule` | 只有一个顶层 `return`，`Drawer` + 两个 `Modal` 都在其中 ✓ |
| `ToolsModule` / `ModelModule` / `WorkPanel` | 浮层与触发入口同在唯一的主 `return` 里 ✓ |
| `TopologyPanel` | 有 `if (graph === null) return <Card loading/>` 早返回，但该分支内无浮层 ✓ |

结论：**只有预览弹窗这一处错位**，本轮修完即无遗留同类问题。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误 |
| 全量测试 | `npm test` **48 files / 319 tests 全绿** |
| 覆盖率门禁 | `npm run coverage` 141/141；`npm run ratchet` 违规 0 |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-CdDznYHF.js`（1,356.82 kB / gzip 424.99 kB），产物仍含 `系统提示词预览` 文案 |
| 活体 | `GET /assets/index-CdDznYHF.js` 返回 200 |
| **未覆盖** | 无 DOM 测试：需用户刷新后点一次「提示词预览」确认弹窗出现（这正是本缺陷逃过自动化的原因——"浮层没挂载"在无 DOM 测试的仓库里只能靠点验） |
| 说明 | 与 S4/S7/S12/S15~S28 的交付口径一致 |

## 5. 遗留

- **这类缺陷没有自动化护栏**：本仓库没有 DOM/组件测试，"state 改了但渲染树里没有消费者"无法被 node 侧用例发现。建议单独立项引入 `jsdom` + `@testing-library/react`（S23/S27/S28 也记过同一条）；若立项，本缺陷应作为回归用例（"详情分支点击预览 → 弹窗可见"）。
- 预览入口只在**项目内实例**维度（`promptPreviewApi` 需要 projectId + instanceId）；Agent 模块的**模板维度**预览需要后端支持，属新需求。
- 弹窗内容仍是纯文本块（`whiteSpace: pre-wrap`）：提示词里的 Markdown 不渲染（与消息不同，这是刻意的——提示词是"运行期原文"，渲染反而可能掩盖真实内容）。
