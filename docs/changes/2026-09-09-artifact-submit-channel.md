# 2026-09-09 修复「角色产物没有进入项目目录」：补上 artifact_submit 提交通道

> 类别：changes · 需求来源：用户反馈"角色产物没有进入到项目目录，是怎么回事，是否取消每个角色的独立工作空间"

## 根因（三个叠加的问题）

1. **提交通道从未实现**：设计里"私有区起草 → 提交到项目工作目录"走 `artifact_submit` 工具，
   但该工具**根本没有注册进工具执行器**（模板 YAML 里写了它，实际不存在）→ 角色写完 `ws://` 就结束，
   产物永远停在 `data/projects/<pid>/workspaces/<iid>/`。
2. **文档角色没有直写能力**：`workdir_edit` 只出现在 dev/qa/ops 模板里；
   product/architect/ux/ui/pm 只有 `ws_write`，所以文档类产物没有任何落地路径。
3. **审批通过后不落地**：doc 类走审批门（`docSubmitApproval=true`），提交后只落 `submitted` + 审批记录；
   而审批决定路由**只处理 `kind==='command'`**，`kind==='submit'` 从不调用 `finalizeApproved`
   → 即使你点"批准"，文件仍然不会写进项目目录。

## 修复

- **注册 `artifact_submit` 工具**（`service-tools.ts`，platform 能力，user 会话所有角色可用，
  老项目快照不必改模板也能用）：参数 `{title,type,summary,files[]}` 或单文件简写 `{path,relPath}`；
  `relPath` 缺省 = 去掉 `ws://` 前缀；按项目策略决定是否需要审批（doc→审批门、code→免审批）。
  提交后产出物记录 + 版本快照（可回退）+ manifest 审计。
- **审批环路补齐**（`app.ts`）：批准 `kind==='submit'` 时调用 `artifacts.finalizeApproved()`
  → 稿件真正拷贝进项目工作目录、置 `approved`、写审计事件。
- **系统提示**（`loop-runner.ts`）：明确"`ws://` 只是草稿区，**交付物必须用 artifact_submit 提交到项目工作目录**才算交付"。
- `composition.ts`：注入 `artifacts` 与项目 `artifactPolicy`；`artifact_submit` 加入平台工具白名单。

## 关于"是否取消每个角色的独立工作空间"

**建议保留私有工作区**，理由：

- 私有区是**草稿区**：半成品不污染项目目录（本次冒烟里 product 先写 draft、再提交定稿就体现了这一点）；
- 产出物有**版本快照 + 一键回退 + 审批门 + diff 审计**，全部直写会丢掉这些；
- 多角色并行时不会互相踩文件（直写同一文件没有版本兜底）。
  真正的问题是"通道缺失"，现已补齐——**交付动作变成显式的一步**（提交即落地）。
  若你确实想让某类角色直写项目目录（草稿也进项目目录），只需给它的模板加上 `workdir_edit`
  （受控直写 + diff 审计，一行改动），我可以按需开启。

## 验证

- `npx tsc`、`npx eslint .` 通过；`npx vitest run --pool=threads` **145 用例全绿**（连跑 3 次稳定）。
  新增 `tests/artifact-submit-m8j.test.ts` 3 例：
  code 类私有区 → 提交 → 文件落到 workdir + artifact approved；
  doc 类提交后 **不落盘** → 用户批准 → 落盘 + approved；
  参数校验（无 files/path、源文件不存在）。
- 真实模型冒烟（deepseek-v4-flash，product 角色）：工具序列 `ws_write → artifact_submit`；
  提交后 artifact `doc/submitted` 且工作目录**无文件**；批准后 `workdir/docs/rules.md` 出现、
  内容为模型写的规则文档、artifact 置 `approved`，私有区草稿保留。

## 遗留（说明）

- `deploy/test/config` 类型当前无需审批（与 config.yaml 策略一致，可扩展）。
- 产出物回退仍走右栏"产出物 → 回退"（按版本快照恢复）。
