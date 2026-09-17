# S25 方案：基础工具包「全员必装」强制化

> 日期：2026-09-16　类型：规则强化（用户直接指令）　真源：`prd.md` FR-26（8 个基础包全员必选）、`design/tool-packages.md`
> 关联：`docs/changes/2026-09-16-s25-packages-always-mounted.md`、`docs/plan/development.md`

## 1 需求

用户原话：**"这 8 个工具包是基础工具，所有 agent 都必须装载"**。追问确认取 **声明/装配层**：保证每个 Agent（内置模板 / 用户模板 / 项目实例快照）的 `packages` 都包含这 8 个；**权限仍按角色白名单**（`pm` 依然不跑命令，命令执行仍只给 dev/ops/qa）。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **写侧强制**：模板写入 / 实例快照生成时，`packages` 以 8 个基础包为地板 | 新建项目后每个实例快照的 `packages` 都完整包含 8 个；复制新建的用户模板同样 |
| R2 | **读侧补齐**：旧数据（S13 之前的实例、手工改过的 yaml）缺包时自动补齐，**不改磁盘文件** | 把实例快照 `packages` 改成 `[]` 后，`GET /team` 的 `effective.packages` 仍是完整 8 个 |
| R3 | **顺序稳定、可比较** | 归一化结果恒为 `[基础 8 包…(固定顺序), 额外包…]`，幂等 |
| R4 | **不放开权限** | `task`/`interaction` 等包的**工具授权**仍按角色白名单（不与本次改动耦合） |
| R5 | 用例钉住 | domain 纯函数用例 + 内置模板全量断言 + 旧数据补齐的集成用例 |

## 2 现状与缺口

| 环节 | 现状 | 缺口 |
| --- | --- | --- |
| 8 个内置模板 yaml | `packages: [fs, cmd, memory, session, artifact, approval, task, interaction]`（8 个全对） | 靠"写对"，无强制 |
| `infra/tools/packages.ts` | 8 个包 `required: true` | 只是**展示元数据**，不参与任何校验 |
| `role-template-store` | 原逻辑：`packages.length > 0 ? packages : BASE` | 只处理"完全为空"，**部分缺**（如 S13 前的模板缺 `interaction`）会漏过 |
| 实例快照生成（`project/service.ts`、`team-service.ts`） | 直接照抄 `template.packages` | 模板缺包 → 实例缺包 |
| 读侧（`effective-config.ts`） | 直接返回 `instance.snapshot.packages` | 旧实例（实测 `proj_97i6x16sx61f` 的 8 个实例快照**一个包都没有**）原样透出 |
| 权限 | 授权链 = 角色工具白名单 × 会话类型 × allowedRoots × 归属校验（**与 `packages` 无关**） | 本轮不动（用户已确认） |

> 实测：用户当天新建的项目（`p_mu3r08e2x036a`「贪吃蛇」）8 个实例快照**都完整含 8 个包**；唯一不符的是 2026-09-15 的旧测试项目，其 `project.json` 连 `schemaVersion` 都没有（接口直接 400），属历史残留。

## 3 关键决定

1. **规则落在 domain（纯函数）**：`src/domain/rules/tool-packages.ts` 的 `normalizePackages(declared)` / `missingBasePackages(declared)`——纯函数、可单测、可被 application 与 infra 同时引用（`.env`/数据都无关）。
2. **读侧补齐而非数据迁移**：不重写任何 `project.json`/`roles/*.yaml`，只在**有效配置解析**（`resolveEffectiveAgentConfig`）与模板读取处归一。理由：① 用户口径是"必须装载"而不是"改我的历史文件"；② 避免一次性迁移脚本与审计噪音；③ 归一化是幂等的，旧数据自然被"治好"。
3. **写侧同时归一**：新建/复制模板、生成实例快照都归一化，保证新数据从一开始就是完整的（读侧补齐是兜底，不是唯一防线）。
4. **补齐而非报错**：缺包不是用户的错（是历史数据/内部代码的问题），拦住创建流程只会制造挫败；因此 `normalizePackages` 静默补齐，`missingBasePackages` 留给断言与日志使用。
5. **顺序固定**：基础包按 `BASE_TOOL_PACKAGES` 顺序在前，额外包（未来的自定义包）在后并去重——便于测试比较与界面展示稳定。
6. **权限与装载解耦**：本轮**不动**角色工具白名单（`pm` 仍无 `cmd_run`/`workdir_edit`）。"装载"是声明/装配层的事实，"能不能用"是策略层的事，两者不该被一次改动混在一起。

## 4 实现步骤

- 新增 `src/domain/rules/tool-packages.ts`（`normalizePackages` / `missingBasePackages`，含规则说明）。
- 应用归一化：
  - `infra/file-store/role-template-store.ts`：读取（原"空则补"改为总是归一）、写入序列化、用户模板补丁写入。
  - `application/team/agent-config-service.ts`（模板视图）、`application/project/service.ts`（创建项目时的实例快照）、`application/team/team-service.ts`（新增成员时的快照）、`application/team/effective-config.ts`（**读侧兜底**，覆盖旧实例）。
- 测试：
  - `tests/unit/domain/tool-packages.test.ts`（5 条：空清单、缺包补齐且顺序固定、额外包保留去重、幂等、`missingBasePackages`）。
  - `tests/integration/server/projects-api.test.ts`：创建项目后**逐个实例**断言快照含 8 包；新增用例模拟旧实例（磁盘快照 `packages: []`）→ `GET /team` 的 `effective.packages` 仍为完整 8 个。
  - `tests/integration/server/tool-packages-api.test.ts`：8 个内置模板逐个断言 `packages` 覆盖全部基础包。
- 文档回写：`prd` FR-26 补注 + 新增 **D30**、`design/tool-packages.md`、`design/ui.md` §2.2/§2.4、`README.md`/`plan/development.md`/`testing/plan.md` + 验收阶段清单加 `s25`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .`（含 domain→shared 合法、infra/application→domain 合法） |
| 单测 | `tests/unit/domain/tool-packages.test.ts` |
| 集成 | `projects-api.test.ts`（新项目人人 8 包 + 旧数据读取补齐）、`tool-packages-api.test.ts`（8 模板覆盖 8 包） |
| 回归 | `npm test` 全绿 + `npm run coverage` + `npm run ratchet` + `npm run build` |
| 活体 | `GET /api/agent-templates` 的 8 个内置模板 `packages` 均为 8 个；`GET /api/projects/:pid/team` 的 `effective.packages` 均为 8 个 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 读侧补齐让人误以为磁盘数据已修好 | `effective-config.ts`、`tool-packages.md` 与本文都写明"**读取侧归一，不改磁盘**"；需要落盘时可另立需求（迁移 + 审计） |
| 未来自定义包被误当基础包 | 归一化只把 `BASE_TOOL_PACKAGES` 顶到前面，其余按声明保留；`missingBasePackages` 只认常量表 |
| 与"角色工具白名单"混淆 | 本轮明确不动白名单；`docs/changes` 里写明"装载 ≠ 授权"，避免下次误改 |
| 旧项目（无 `schemaVersion`）仍然打不开 | 与本轮无关的历史残留（接口 400），已在记录里标注，若要清理需单独确认 |
