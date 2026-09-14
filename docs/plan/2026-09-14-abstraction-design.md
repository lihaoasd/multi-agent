# 开发方案 · 代码抽象设计（分层 / 端口 / 依赖注入）

> 类别：plan · 状态：已完成（2026-09-14） · 类型：设计（非实现）· 执行结果见 [修改记录](../changes/2026-09-14-abstraction-design.md)
> 关联：[abstraction.md](../design/abstraction.md)（本次交付物）、[architecture.md](../design/architecture.md) §4/§4.1、[prd.md](../requirements/prd.md)

## 1. 需求

用户要求：**完成代码的抽象设计**——高扩展性、合理使用设计模式、实现依赖注入。

澄清结论（2026-09-14）：

| 议题 | 结论 |
| --- | --- |
| 交付形态 | **设计文档 + 完整接口签名**（不创建 `src/` 代码）——2026-09-14 用户确认"就按现状" |
| DI 方式 | **自研轻量容器**（register/resolve/scope + token，构造器注入，无装饰器/反射，零新依赖）——2026-09-14 用户确认 |
| 错误风格 | **领域 Result + 边界异常**（与 REST `{code,message}`、工具 `{ok,code,reason}` 对齐） |
| 动态配置诉求 | 必须支持**未来**：用户自定义工具包/Agent，并在项目中**动态修改实例的工具与 loop**，且不重建容器、不重启 |

## 2. 方案要点

1. **六层依赖规则**（shared → ports → domain → application → infra/server → bootstrap），依赖只向内；用 eslint zones + ratchet 门禁，`domain`/`ports` 出现 `node:fs` 即失败。
2. **端口-适配器**：`ports/` 只放接口与 DTO；`infra/` 提供文件系统适配器与 Mock 适配器；跨层只能通过端口。
3. **领域模型**：聚合根（Project / Session / Task / OrchestrationGraph …）+ 纯函数状态机 + 不变式清单，明确"谁保证哪条不变式"。
4. **DI 容器**：`Token<T>` + `register/resolve/createScope`，生命周期 singleton/scoped/transient；**组合根**（`bootstrap/`）统一装配，测试用 mock 组合根。
5. **动态配置三约束**（本次核心，回答"能否支持用户动态改工具与 loop"）：
   - 容器注入稳定能力（端口 / 注册表 / 解析器），**不注入实例级配置**；
   - 实例有效配置每回合由 `EffectiveAgentConfigResolver` 解析（模板快照 → 实例覆盖 → 项目策略 → 平台默认）→ 作为 `TurnContext.config` **参数**传递；
   - 工具与 loop 按 id 从 `ToolRegistry` / `LoopRegistry` **运行期查表**（Strategy + Registry 模式）。
6. **设计模式清单**：明确每个模式解决什么问题、落在哪个文件；同时列出**反模式**（服务定位器滥用、万能事件总线承载业务逻辑、过早泛型仓储）。
7. **扩展点操作手册**："新增工具 / 工具包 / loop 策略 / 模型 provider / 产出物类型 / 场景 / 存储后端 / WS 事件"分别要改哪些文件、是否要动容器。

## 3. 交付物

| 文件 | 内容 |
| --- | --- |
| `docs/design/abstraction.md` | 本次全部内容：分层与依赖规则、领域模型、端口清单（含完整 TS 接口签名）、DI 容器、模式清单、扩展点手册、目标目录结构、测试与门禁、演进路线 |
| `docs/README.md` | 文档地图登记 `abstraction.md`；术语表补 `端口 / 适配器 / 组合根 / Token / 作用域` |
| `docs/design/architecture.md` | §4.1 指向 abstraction.md（端口真源从架构概述升级为专文） |

## 4. 验证方式

- 每个端口都有：职责、方法签名、默认适配器、测试替身、**失败语义**（Result 错误码）。
- 每条"高扩展"承诺都能落到一个扩展点手册条目（改哪些文件、是否动容器）。
- 动态配置诉求有明确机制与时序（改配置 → 何时生效 → 是否需要重建对象图）。
- 与 PRD 已定的约束一致：单进程、纯文件系统、不引重型依赖、职责链校验（注册→白名单→会话类型→策略→边界→归属）。
- 文档链接可解析；术语与 `docs/README.md` 一致。

## 5. 不在本次范围

- 创建 `src/` 代码（含接口骨架文件）；
- 第三方 DI 库评估（结论：不引入，理由见 abstraction.md §5.1）；
- 具体算法实现（索引分词、上下文裁剪、画布布局）；
- 未决项 U8~U12 的实现方案。
