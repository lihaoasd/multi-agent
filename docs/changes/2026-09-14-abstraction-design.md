# 修改记录 · 代码抽象设计（分层 / 端口 / 依赖注入）（2026-09-14）

> 类别：changes · 类型：设计（非实现）· 方案：[docs/plan/2026-09-14-abstraction-design.md](../plan/2026-09-14-abstraction-design.md)
> 需求来源：用户"完成代码的抽象设计，高扩展性，合理使用设计模式，实现依赖注入模式"

## 1. 交付内容

新增 **`docs/design/abstraction.md`**——代码抽象契约真源，共 13 节：

| 节 | 内容 |
| --- | --- |
| §1 目标与原则 | 高扩展/可替换/可测/用户可动态配置/零重型依赖；6 条设计原则 |
| §2 分层与依赖规则 | 六层（shared→ports→domain→application→infra/server→bootstrap）、允许/禁止依赖表、eslint zones + ratchet 门禁 |
| §3 领域模型 | 9 个聚合/实体与不变式归属；5 个纯函数状态机；领域事件规范 |
| §4 端口清单 | 存储 12 + 模型 3 + 执行 6 + 策略 6 + 平台 7；**§4.6 给出 12 个核心接口的完整 TS 签名** |
| §5 依赖注入 | 为何自研（对比表）、`Container`/`Token` 接口、生命周期、组合根装配、**§5.5 动态配置三约束 + 生效时序表**、测试注入 |
| §6 设计模式清单 | 16 个模式（Ports&Adapters/DI/Strategy/Registry/Repository/UoW+KeyedLock/Observer/CoR/Decorator/Command/Builder/State/Template Method/Policy/Snapshot/Result）+ **5 条反模式禁令** |
| §7 扩展点操作手册 | 新增工具/工具包/loop 策略/provider/产出物类型/场景/WS 事件/存储后端/端点：步骤与"是否动容器" |
| §8 目标目录结构 | `src/{shared,ports,domain,application,infra,server,bootstrap}` + `web/` + `tests/` |
| §9 错误与结果约定 | 领域 `Result` / 边界异常 / 三层映射（REST、工具、事件）共用一套错误码 |
| §10 测试与可替换性 | 分层测试表 + **端口契约测试**（真实实现与 Mock 同套断言） |
| §11 开发门禁 | 依赖规则、端口唯一注册处、命名、失败语义注释、覆盖率 |
| §12 演进路线 | MVP → U8/U9 → U11 → P1 向量 → P2 多进程，各自影响面 |
| §13 风险与未决 | 容器边界侵蚀、端口过度拆分、事件顺序、自研容器替换路径 |

## 2. 修订文件

| 文件 | 改动 |
| --- | --- |
| `docs/README.md` | 文档地图登记 `abstraction.md`；阅读顺序插入抽象设计；术语表新增 5 条（端口/适配器、组合根、DI/Token/作用域、有效配置） |
| `docs/design/architecture.md` | §4.1 端口表前加注：完整抽象契约以 `abstraction.md` 为准 |
| `docs/plan/2026-09-14-abstraction-design.md` | 新建：本次方案 |
| `docs/changes/2026-09-14-abstraction-design.md` | 新建：本记录 |

## 3. 关键决定（可推翻）

1. **DI 用自研轻量容器**（不引 awilix/tsyringe/InversifyJS）：零依赖、无装饰器/反射、装配集中在组合根；`Container` 本身是端口，将来可整体替换。**2026-09-14 用户确认采用**。
2. **错误风格：领域 `Result` + 边界异常**（用户已确认）：与 REST `{code,message}`、工具 `{ok,code,reason}`、事件 `kind=error` 三层映射共用同一错误码集。
3. **动态配置三约束**（回答"能否支持用户后续自定义工具/Agent、运行时改实例工具与 loop"）：
   - 容器只注入**稳定能力**（端口/注册表/解析器），不注入实例级配置；
   - 实例**有效配置**每回合由 `EffectiveAgentConfigResolver` 解析，作为 `TurnContext.config` **参数**传递；
   - 工具与 loop 按 id **运行期查表**（`ToolRegistry` / `LoopRegistry`）。
   结论：改实例工具/循环 **下一回合生效，不重建容器、不重启**；只有"换存储后端/改平台 `.env`"才需要重启。
4. **六层依赖规则 + ratchet 门禁**：`domain`/`ports` 出现 `node:*` 直接失败；`application` 依赖 `infra` 直接失败。
5. **反模式禁令**（写进 review 清单）：服务定位器滥用、事件总线承载业务逻辑、过早泛型仓储、把配置当依赖、domain 引 IO。
6. **交付形态**：本次只出设计文档 + 完整接口签名，**不创建 `src/`**（**2026-09-14 用户确认**；后续如需接口骨架 `.ts` 文件可另开一轮）。

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 端口完备性 | 5 类共 34 个端口，每个都有职责/默认适配器/测试替身；12 个核心端口给出完整 TS 签名与失败语义 |
| 扩展性可操作 | 9 类扩展各给步骤与"是否动容器"，与 §5.5 生效机制闭环 |
| 动态配置诉求 | 三约束 + 时序 + 8 行生效表（改什么 → 何时生效 → 是否重建容器/重启） |
| 与既有设计一致 | 单进程、纯文件系统、不引重型依赖；错误码与 `contract.md` §4 同源；工具校验链与 `tools.md` §5 一致；编排约束与 `orchestration.md` §1 一致 |
| 文档链接 | 全库 **0 断链**（22→24 份文档） |
| 命名冲突 | 全库无 `AGENTS.md`（避免设计文档被误当目录指令文件） |

## 5. 未做

- 不创建任何 `src/`/`tests/` 代码（含接口骨架）；
- 不评估第三方 DI 库（结论已定：不引入）；
- 不设计具体算法（索引分词、上下文裁剪、画布自动布局）；
- U8（自定义工具包格式与信任）、U9（配置提交校验与版本）、U11（第三方/MCP 接入）仍待定；
- 盘点遗留 P0（doc 提交审批、产出物面板/回退入口、事件规范三套词汇、`config.yaml` 残留、模型 provider id、锁机制术语）。

## 6. 回滚

改动仅 4 个文件（2 新增 + 2 修订）：删除 `docs/design/abstraction.md`、`docs/plan/2026-09-14-abstraction-design.md`（及本记录），并 `git checkout HEAD -- docs/README.md docs/design/architecture.md`。
