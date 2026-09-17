# 修改记录 · S25 基础工具包「全员必装」强制化

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s25-packages-always-mounted.md](../plan/2026-09-16-s25-packages-always-mounted.md)
> 关联设计：[tool-packages.md](../design/tool-packages.md)、[prd](../requirements/prd.md) FR-26 / D30

## 1. 需求 / 问题

用户口径：**"这 8 个工具包是基础工具，所有 agent 都必须装载"**；追问确认取**声明/装配层**（权限仍按角色白名单）。

现状：`packages` 只是"yaml 写对 + 创建实例时照抄"的**约定**，没有任何强制，也没有兜底：

| 环节 | 缺口 |
| --- | --- |
| `role-template-store`（原逻辑 `packages.length > 0 ? packages : BASE`） | 只处理"完全为空"，**部分缺包**（如 S13 前缺 `interaction`）会漏过 |
| 实例快照生成（`project/service.ts`、`team-service.ts`） | 直接照抄模板，模板缺包 → 实例缺包 |
| 读侧（`effective-config.ts`） | 原样透出快照，旧实例缺包就是缺包 |

**实测数据**：用户当天新建的项目（`p_mu3r08e2x036a`「贪吃蛇」）8 个实例快照**都完整含 8 个包**；8 个内置模板 yaml 也都是 8 个。唯一不符的是 2026-09-15 的旧测试项目 `proj_97i6x16sx61f`（8 个实例快照**一个包都没有**），且该文件的 `project.json` 连 `schemaVersion` 都没有——接口对它直接 400（历史残留，与本轮无关）。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| domain（新增） | `src/domain/rules/tool-packages.ts` | `normalizePackages(declared)`：基础 8 包按 `BASE_TOOL_PACKAGES` 顺序顶到前面 + 额外包去重保留在后；`missingBasePackages(declared)`：缺哪些基础包（供断言/日志）；文件内写明"**8 个基础包是地板，不是可选项**" |
| infra | `src/infra/file-store/role-template-store.ts` | 读取时 `normalizePackages(packages)`（替换原"仅空则补"）、写入序列化归一、用户模板补丁写入归一 |
| application | `src/application/team/agent-config-service.ts` | 模板视图 `packages` 归一 |
| application | `src/application/project/service.ts` | 创建项目时的实例快照 `packages` 归一 |
| application | `src/application/team/team-service.ts` | 新增成员时的实例快照 `packages` 归一 |
| application | `src/application/team/effective-config.ts` | **读侧兜底**：`effective.packages = normalizePackages(instance.snapshot.packages)` → 旧实例自动补齐，**不改磁盘** |
| tests（新增） | `tests/unit/domain/tool-packages.test.ts` | 5 条：空清单→8 个、缺包补齐且顺序固定、额外包保留去重、幂等、`missingBasePackages` |
| tests | `tests/integration/server/projects-api.test.ts` | 创建项目后**逐个实例**断言快照含全部基础包；新增用例模拟旧实例（磁盘快照 `packages: []`）→ `GET /team` 的 `effective.packages` 仍为完整 8 个 |
| tests | `tests/integration/server/tool-packages-api.test.ts` | 8 个内置模板逐个断言 `packages` 覆盖全部基础包 |
| docs | `prd`（FR-26 补注 + **D30**）、`design/tool-packages.md`、`design/ui.md` §2.2/§2.4、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单 | 全链路回写 |

**未改**：角色**工具白名单**（权限层）——`pm` 仍无 `cmd_run`/`workdir_edit`，命令执行仍只给 dev/ops/qa；`infra/tools/packages.ts` 的 `required: true` 元数据；后端接口。

## 3. 关键决定

1. **规则落在 domain 纯函数**：可被 application 与 infra 同时引用（层规则允许），且能被 node 侧单测直接覆盖。
2. **读侧补齐而不是数据迁移**：不重写任何 `project.json` / `roles/*.yaml`——用户口径是"必须装载"而非"改我的历史文件"；归一化幂等，旧数据自然被治好，也避免一次性迁移脚本与审计噪音。（本文与 `tool-packages.md` 都写明"**读侧归一，不改磁盘**"；若将来要求落盘，需另立迁移需求。）
3. **写侧同时归一**：新建/复制模板与生成实例快照都归一，保证新数据天然完整；读侧只是兜底。
4. **静默补齐而不是报错**：缺包是历史数据或内部代码的问题，不该拦住用户的创建流程；`missingBasePackages` 留给断言/日志。
5. **顺序固定**：基础包恒在前（`BASE_TOOL_PACKAGES` 顺序），额外包在后去重 → 测试比较与界面展示稳定。
6. **"装载 ≠ 授权"**：本轮只保证挂载，不放开权限。这是刻意解耦，避免把"包能装"与"工具能用"混成一次变更（也避免误改 FR-13 的角色边界）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（domain→shared 合法、infra/application→domain 合法，层规则未被破坏） |
| 单测 | `tests/unit/domain/tool-packages.test.ts` **5 passed** |
| 全量测试 | `npm test` **49 files / 328 tests 全绿**（新增 5 + 1 条，并扩展 2 处既有断言） |
| 覆盖率门禁 | `npm run coverage` **141/141**（新增的 `domain/rules/tool-packages.ts` 已被用例触达，总数 140 → 141）；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过（本轮无前端改动，产物哈希不变 `index-C05vfHbu.js`） |
| 旧数据回归 | 集成用例把实例快照 `packages` 置空后，`GET /api/projects/:pid/team` 的 `effective.packages` 仍返回完整 8 个（读侧补齐生效） |
| 说明 | 与 S4/S7/S12/S15~S24 的交付口径一致 |

## 5. 遗留

- **权限层未动**（按用户选择）：`pm` 依旧没有 `cmd_run`/`workdir_edit`；若将来要"每个角色都能用全部基础工具"，那是 FR-13 与角色设计的变更，需单独确认。
- **磁盘数据未迁移**：旧项目文件里的 `packages` 仍可能是旧的/空的，只是读取时被补齐。若希望"文件本身也修好"（便于人工查看与导出），需要一次启动迁移 + `config-audit.jsonl` 留痕。
- **`infra/tools/packages.ts` 的 `required: true` 仍是展示元数据**，没有参与校验；现在约束由 `domain/rules/tool-packages.ts` 承担。若以后要支持"自定义包 / 卸载基础包"，应先让这两处对齐（避免两个真相源）。
- **历史残留项目**：`data/projects/proj_97i6x16sx61f`（2026-09-15，缺 `schemaVersion`，接口 400）仍未处理；它属于旧格式残留，清理需你确认（`data/` 是你的运行数据）。
