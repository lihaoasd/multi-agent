# 修改记录 · 开发计划（编码阶段执行计划）（2026-09-15）

> 类别：changes · 类型：设计（非实现）· 方案：本文件即计划的交付记录（总计划自身不另写方案）
> 需求来源：用户"制定开发计划"

## 1. 交付内容

新增 **`docs/plan/development.md`**——prd §9 验收 5 点名、但仓库一直没有的"编码阶段执行计划"，共 10 节：

| 节 | 内容 |
| --- | --- |
| §1 目的与使用方式 | 输出阶段划分/依赖/验收/风险；非需求或设计真源；阶段用 **`S0`~`S9`**（**不复用历史 `M1~M14`**，依据 README §3.2） |
| §2 现状与前置条件 | 仓库无实现代码；`package.json`/`tsconfig`/vitest/eslint 配置随 `0217e21` 清空 → S0 需重建脚手架；`data/` 内旧 `model-config.json`/`agent-models.json` 按 model-config §11 处理 |
| §3 阶段总览 | 10 行表格：阶段 / 目标 / 主要交付物 / 依赖 / 覆盖测试规则 / **状态**；关键路径 `S0→S1→S2→S3→S4→S6→S7→S8→S9`，S5 可与 S4/S6 并行 |
| §4 S0 细节 | 工程脚手架与**依赖门禁先行**（eslint zones + ratchet、`Container`、`/health`），6 个步骤 + 验收（含"故意越层 import 必须被拦"） |
| §5 S1 细节 | **模型配置模块 + Agent 配置提交**（本轮设计的落地）：10 个步骤（端口→预置 YAML→`ModelConfigStore`→5 适配器→`ModelCatalog`→`ModelConfigService`→REST/WS→`AgentConfigService`→前端→测试）、验收=prd §9 验收 8、本阶段不做清单 |
| §6 S2~S8 要点 | 每阶段目标/关键交付/验收要点与覆盖测试规则（存储与项目、会话与单工、loop 与工具、记忆与检索、产出物/任务/询问、编排画布与前端、恢复与运行控制） |
| §7 完成定义（DoD） | 6 条：测试、门禁、契约回写、存储回写、留痕、可演示；缺一不算完成 |
| §8 风险与应对 | 9 项：门禁未先行、loop 三策略"提示级"现状、单工与跨重启恢复、5 种协议差异、密钥脱敏、编排并发、脚手架重建、CRLF/LF、文档漂移 |
| §9 不在本计划内 | U8/U10/U11/U12、U9 剩余、U13~U16、P1/P2 需求、深色主题与 i18n |
| §10 进度记录方式 | 阶段起止各写 plan/changes 文件，并维护 §3 表格"状态"列 |

## 2. 修订文件

| 文件 | 改动 |
| --- | --- |
| `docs/README.md` | §1 文档地图登记 `plan/development.md`（并在 plan 行注明其为总计划、属按日期命名约定的**例外**）；阅读顺序末尾插入"`plan/development.md`（编码阶段执行顺序）" |
| `docs/plan/development.md` | 新建：本计划 |
| `docs/changes/2026-09-15-development-plan.md` | 新建：本记录 |

## 3. 关键决定（可推翻）

1. **落在 `docs/plan/development.md`**：这是 `prd.md` §9 验收 5 明确点名的路径。它偏离 README §1 的"按日期命名"约定，故在 README 的 plan 行显式标注为例外，并在计划 §1 说明"总计划固定名 + 单体改动仍按日期命名"。
2. **阶段编号用 `S0`~`S9`，不用 `M`**：README §3.2 规定 `M1~M14` 属历史里程碑编号（出处已随重启删除），新增文档不得复用；`P` 前缀又已被 PRD 的优先级（P0/P1/P2）占用。
3. **门禁先于业务代码（S0）**：`abstraction.md` §2 的六层依赖规则若不在第一行代码前生效，越层 import 会随实现扩散，返工成本远高于先建脚手架。
4. **S1 = 本轮模型配置模块设计**：把刚定稿的 `model-config.md` 作为 S1 的输入设计，使"计划 → 设计 → 实现"链条闭合；S1 的验收直接引用 prd §9 验收 8，不另立标准。
5. **把 loop 三策略的"提示级现状"列为 S4 交付项**：`agent-runtime.md` §3 已如实标注三条策略当前只有提示级差异、`maxIterations`/`toolBudget` 无消费者；计划要求 S4 补真实形态，并在 S4 之前对 UI 标注"参数待生效"，避免"配了没用"。
6. **计划不绑日期**：只定顺序、依赖、验收与风险，不承诺工期；`S1` 的 10 个步骤是"可并行/可拆分"的粒度，不是工时估算。
7. **不引入新需求**：全部阶段与验收均可追溯到 prd 的 US/FR 与 `testing/plan.md` 的规则编号。

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 悬空引用收口 | `prd.md` §9 验收 5 引用的 `docs/plan/development.md` **现已存在**（上一轮修改记录 §5 记录的既有缺陷就此解析） |
| 文档链接 | 全库 32 份文档、184 条相对链接，**0 断链**（脚本逐条 `Test-Path` 校验） |
| 编号冲突 | 新文档通篇无 `M` 前缀里程碑编号（仅在 §1 显式声明"不复用 `M1~M14`"）；阶段 `S0`~`S9` 与 prd 的 `P0/P1/P2` 优先级、决策 `D1~D20`、未决 `U1~U16`、测试规则 `1~31` 均无冲突 |
| 规则编号可追溯 | §3 表格"覆盖测试规则"列的 1~31 全部存在于 `testing/plan.md`；S1 列 27~31 与设计文档引用的规则 27~31 一致 |
| 设计真源一致 | 阶段交付物名（`ModelConfigStore`/`ModelCatalog`/`ProviderKindAdapter`/5 种 kind/`agent-config.updated`）与 `model-config.md`、`abstraction.md` §4.2/§4.6 一致；落盘路径与 `data-storage.md` §2 一致 |
| 需求一致 | S1 验收 = prd §9 验收 8；S2~S8 验收要点逐条对应 `testing/plan.md` 规则与 prd US/FR；未新增需求条目 |

## 5. 未做

- 不做任务级排期、工时估算与人力分配（本计划只定顺序与验收）；
- 不创建任何 `src/` / `tests/` 代码，不重建 `package.json`（属 S0 执行内容）；
- 不细化 S2~S8 的逐步方案（按 §10 约定，各阶段开始时再写各自 `docs/plan/YYYY-MM-DD-<topic>.md`）；
- 未处理 `agent-runtime.md` §3"实现现状"标注（其描述的是已被 `0217e21` 清空的旧代码）——已作为 S4 交付项列入计划 §6（S4 行）与 §8（风险表）；
- 本轮改动**未提交 git**（等待指示）。

## 6. 回滚

```bash
git rm docs/plan/development.md docs/changes/2026-09-15-development-plan.md
git checkout HEAD -- docs/README.md
```
