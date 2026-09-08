# 开发方案 · Agent Haness（里程碑与切片）

> 类别：plan · 状态：草稿(待评审) · 关联：[prd.md](../requirements/prd.md)（验收脚本）、[architecture.md](../design/architecture.md)
> 原则：先可运行骨架与稳定接口边界，再按**纵向切片**端到端打通；每里程碑可演示、可测试、可回退。

## 1. 技术准备

- Node ≥ 20 + pnpm/npm；TS strict；Vitest；ESLint+Prettier。
- 仓库结构与 config.yaml 骨架（配置加载/错误码/日志）。
- 数据模型先按 data-storage.md 的 schema 落 type 定义（shared 层），文件存储层先行（原子写/边界校验）——它是所有功能的地基。

## 2. 里程碑总览

| 里程碑 | 内容 | 演示/验收（每个都跑通才进下一步） |
| --- | --- | --- |
| M0 工程骨架 | monorepo 单仓结构、config、错误码、日志、file-store(原子写/边界)、目录浏览 API、项目 CRUD(纯数据) | `npm run dev` 起服务；API 建/列/删项目；fs browse 返回受限目录 |
| M1 角色库与项目组队 | 角色模板(内置8)加载、项目创建向导数据链路、team CRUD、runtime project 文件夹落盘、user 会话骨架 | 向导建项目(选目录+勾角色) → project.json/workspaces/sessions 出现且结构符合 schema |
| M2 单 Agent 聊天闭环（Mock 起步） | model-gateway(openai-compatible/ollama/mock)、会话窗口读写、事件模型(seq/turn/kind + turn_start/turn_end)、WS 推送(流式 chunk+commit，消息整体落盘 D14-⑦)、Agent 单轮 direct loop、先盘后推 | UI 与 product 角色 Mock 对话，消息流式+落 log；重启恢复会话窗口 |
| M3 Agent 运行时与工具 | dispatcher 单工状态机(排队/挂起/恢复)、loop 策略(direct/reflective/plan-execute)、工具注册表+路径边界、cmd_run 白名单+高危审批、审批队列与卡片（工具/沙箱规范：design/tools.md、design/sandbox.md） | 让 dev 角色执行"读文件→写私有区→提交 doc"全链路；高危命令弹审批，批准后执行 |
| M4 产出物提交制 | 静态产物提交(校验/拷贝/manifest/版本/回退+versionDir 快照，H2)+ 代码受控编辑**任务级**聚合(D14-⑧)+ 产出物面板 | 提交 PRD → workdir/docs 出现；回退恢复内容一致；右栏 manifest 正确 |
| M5 记忆与检索 | 会话滚动摘要、L3 长期条目(角色/全局、提取规则)、会议纪要生成、倒排索引+搜索 UI、resume_context | 长会话后摘要生效、上下文构建省 token；搜索命中跳转；重启恢复含摘要 |
| M6 会议机制 | meeting 发起/入会(单工挂起)/轮次引擎/用户决策点阻塞/插话/结束纪要回写、会议 UI | 复现验收脚本中"会议阻塞等用户拍板→答复→纪要回写" |
| M7 工作台完善 | 三栏布局完善(左状态徽标/中聊天与会议/右 tabs)、未读、重连增量、深色主题、导出 zip | 全程 UI 操作完成 M0~M6 演示，无需手敲 API |
| M8 质量与交付 | 测试补全、README 落地、打包、真实模型(DEEPSEEK/Ollama)验收、权限策略配置验证 | `npm run test` 全绿；真实模型跑验收主路径（prd §9） |

## 3. 纵向切片建议（M0 之后推荐按以下切片推进）

- **切片 A（M1→M2 打通）**：创建项目 → 与 PM 用 Mock 对话（覆盖 会话/session log/单轮回复）。最先让"能聊天、能落盘、能恢复"成立。
- **切片 B（M3→M4 打通）**：dev 角色执行真实任务：写私有草稿→提交文档产物→命令执行(带审批)→回退。覆盖工具与安全主线。
- **切片 C（M5→M6 打通）**：记忆与会议：长会话摘要、PM 发起两方会议、阻塞拍板、纪要回写。
- 每个切片结束做一次 prd §9 验收主路径的回放，发现设计缺陷立即回改设计文档（改动记录同步）。

## 4. 关键实现顺序细化（M3 内部）

1. 事件总线（领域事件统一落 log 与推送）——所有功能的骨架；
2. dispatcher 状态机（纯函数+单测）→ 接入回合执行；
3. loop 注册表 + model-gateway 流式；
4. 工具执行器（schema 校验/边界/风险判定/审批桥）→ 审批队列/卡片。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 上下文窗口/token 失控 | 摘要滚动 + 窗口裁剪（M5）；contextLimits 配置；检索注入上限 |
| 异步会议逻辑复杂（轮次+阻塞+插话交错） | 会议状态机先纯函数建模+大量单测（M6 前置）；**MVP 同一项目同一时刻至多 1 个进行中会议**（D14-⑥，新发起排队，实现与心智都最简）|
| Agent 工具越界/误操作真实目录 | 目录边界强制校验（M0 就绪）+高危审批+全审计；命令 cwd 恒 workdir |
| 长任务把单工卡死 | 可中断点设计 + 回合停顿汇报；用户可"打断"入队优先处理 |
| 模型质量导致产出混乱 | Mock 先行自动化；每角色默认 loop 与模型建议表；反思策略兜底 |
| 记忆与日志文件膨胀 | 轮转(5 万行)+索引可再生+导出清理 |

## 6. 每步验证方式

- 单元：domain 状态机/规则/解析（无 IO）。
- 集成：file-store 原子写与边界；session 落盘回读；审批流；会议状态流（Mock 模型）。
- 端到端：验收脚本（prd §9）人工走查 + Playwright（P1）。
- 命令：`npm run test`、`npm run dev`、`npm run build && npm run start`。
