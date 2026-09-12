# 2026-09-09 产出物提交免审批 + 移除「产出物」栏

## 需求/问题

用户（老板角色）在体验 M8 工作台后提出两条：

1. **提交产出物不需要审批，自动提交上去**——此前 `artifact_submit` 对 doc/config/deploy/test 等静态类型走"doc 门"：只落 `state=submitted` + 审批卡，用户批准后才写入项目工作目录；用户体验上等于"交付物卡在审批里"。
2. **产出物没有退回功能，不需要产出物这栏**——右栏「产出物」面板（列表 + 回退按钮）没有实际使用价值，要求移除。

## 影响分析

| 项 | 影响 |
| --- | --- |
| 提交语义 | 提交即交付：`artifact_submit` 一律以 `needsApproval=false` 调 `ArtifactService.submit` → 直接拷贝进项目工作目录 + 写版本快照 + `state=approved`，不再产生 `kind='submit'` 审批记录 |
| 审批栈 | 不受影响：高危命令审批（`highRiskCommands`）与产出物无关，仍走 `approvals.jsonl`；`POST /approvals/:id/decide` 对历史 `submit` 记录的 finalize 分支保留（兼容旧数据） |
| 项目策略字段 | `artifactPolicy`(docSubmitApproval/codeSubmitApproval) 仍在 `project.json`/`config.yaml` 数据模型中保留，但**已无运行时读取方**；`registerServiceTools` 的 `artifactPolicy` 注入删除（死参数） |
| 前端 | 右栏删除「产出物」栏；`renderArtifacts`、`/artifacts` 与 `/artifacts/:id/rollback` 请求、`current.artifacts` 一并删除；`.artifact-item` 样式删除 |
| 后端接口 | `GET /artifacts`、`POST /artifacts/:id/rollback`、`ArtifactService.rollback/finalizeApproved` 保留（供审计/版本恢复/旧数据），只是不再有 UI 入口 |
| 版本快照 | 保持不变（`artifact-versions/<id>/v<n>`），交付文件仍可追溯 |

## 改动范围

- `src/application/tools/service-tools.ts`
  - `artifact_submit`：`const needsApproval = false`（提交不走审批门）；工具描述由"doc 类默认需要用户审批，code 类免审批直接落地"改为"提交即落地（不需要用户审批）"；返回值去掉 `approvalId` 分支，统一"已提交产出物 … → 项目工作目录：…"。
  - 删除 `artifactPolicy` 依赖参数与解构（唯一消费方就是上面的提交门）。
- `src/application/composition.ts`：`registerServiceTools` 去掉 `artifactPolicy` 注入。
- `web/index.html`：右栏删除 `<h4>产出物</h4><ul id="artifact-list">`。
- `web/app.js`：`current.artifacts`、`refreshPanels` 中的 `/artifacts` 拉取与渲染分支、`renderArtifacts()` 全部删除。
- `web/style.css`：`.artifact-item` 选择器删除（保留 `.meeting-item`）。
- `config.yaml`：`docSubmitApproval` 行加注"当前不读此值"。
- 文档：`README.md`（产出物提交制/工作台/私有工作区/code 通道四处）、`docs/design/workspaces-artifacts.md`（§3 状态机、§4 可见性、§6 审批默认值）、`docs/design/tools.md`（工具表两行）。

## 测试

- `tests/artifact-submit-m8j.test.ts`
  - doc 用例改写：**提交即落地**——`summary` 含"项目工作目录"、文件立即写入 workdir、artifact `state=approved`、`approvalId=null`、`approvals.list(pid,'pending')` 为空。
  - code 用例注释由"code 门默认免审批"改为"提交即落地，不走审批门"。
- `tests/static-web-m8k.test.ts` 新增用例：`GET /` 不含"产出物"/`artifact-list`，`GET /app.js` 不含 `renderArtifacts`、`/artifacts`、`/rollback`（防 UI 回归）。

## 验证结果

- `npx tsc -p tsconfig.json` → exit 0
- `npx eslint .` → exit 0
- `npx vitest run --pool=threads` → **24 文件 / 148 用例全绿**（含新增静态栏位断言）
