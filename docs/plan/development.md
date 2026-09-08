# 开发方案 · Agent Haness（分阶段执行计划，带用户确认闸门）

> 类别：plan · 状态：已评审（2026-09-08 用户确认：沿用 M0~M8，每阶段完成且用户验证后，确认放行下一阶段）· 关联：[prd.md](../requirements/prd.md)、[architecture.md](../design/architecture.md)、[testing/plan.md](../testing/plan.md)
> 原则：先可运行骨架与稳定接口边界，再按**纵向切片**端到端打通；每阶段**完整、可演示、可测试、可回退**；**用户验证通过并明确确认后**才进入下一阶段。

## 0. 执行节奏协议（本方案总纲）

每阶段（Phase = M0~M8 的单个里程碑）按以下固定节奏推进，**不允许跳闸**：

1. **阶段计划**：进入某阶段前，先在本文件对应小节给出该阶段的「改动范围 / 实现步骤 / 验证方式」，评审确认后编码（本方案即评审通过的阶段划分；每阶段开头可再细化）。
2. **实现与记录**：按方案最小化实现；代码、测试、配置、文档改动同步追加 `docs/changes/` 修改记录。
3. **本机验证**：跑 `npm run test`（单元+集成全绿）+ 阶段验收命令；diff 逐行可追溯到需求。
4. **用户验证**：给出**可操作验证清单**（启动命令 + 逐条 UI/API 操作 + 期望结果），用户照做。
5. **确认闸门**：用户验证通过并回复「确认/继续」→ 进入下一阶段；未通过则按反馈修订后重新验证。**阶段之间默认停顿等待确认。**

## 1. 技术准备

- Node ≥ 20 + pnpm/npm；TS strict；Vitest；ESLint+Prettier。
- 仓库结构与 config.yaml 骨架（配置加载/错误码/日志）。
- 数据模型先按 data-storage.md 的 schema 落 type 定义（shared 层），文件存储层先行（原子写/边界校验）——它是所有功能的地基。

## 2. 里程碑总览（阶段划分）

| 阶段 | 内容 | 交付物（完成标准） | 用户验证步骤（照做后确认） |
| --- | --- | --- | --- |
| **M0 工程骨架** | monorepo 单仓结构、config、错误码、日志、file-store(原子写/边界)、目录浏览 API、项目 CRUD(纯数据) | `npm run dev` 起服务(:3000)；API 建/列/查/删项目；fs browse 返回受限目录；`npm run test` 全绿；改动记录归档 | ① `npm run dev` 后浏览器开 `http://127.0.0.1:3000/api/config` 见 JSON；② POST 建项目（真实目录作 workdir）→ GET 列表出现 → GET/PATCH 详情 → DELETE 消失且 workdir 原目录未被删除；③ `GET /api/fs/browse` 列出指定目录并过滤隐藏/系统项 |
| **M1 角色库与项目组队** | 角色模板(内置8)加载、项目创建向导数据链路、team CRUD、runtime project 文件夹落盘、user 会话骨架 | 向导建项目(选目录+勾角色) → project.json/workspaces/sessions 出现且结构符合 schema；team API 增删改查；改动记录归档 | ① POST 建项目带 team 配置 → 检查 `data/projects/<pid>/` 下 project.json/workspaces/<iid>/ 结构；② GET/PATCH team（改名/停用 enabled=false）生效；③ user 会话 meta 文件生成 |
| **M2 单 Agent 聊天闭环（Mock 起步）** | model-gateway(openai-compatible/ollama/mock)、会话窗口读写、事件模型(seq/turn/kind + turn_start/turn_end)、WS 推送(流式 chunk+commit，消息整体落盘 D14-⑦)、Agent 单轮 direct loop、先盘后推 | UI 与 product 角色 Mock 对话，消息流式+落 log；重启恢复会话窗口；改动记录归档 | ① 创建项目组 PM+产品 团队；② 在会话窗口发消息 → Mock 流式回复逐字出现、结束后 log 落盘完整一条；③ 重启服务重开会话 → 历史消息仍在 |
| **M3 Agent 运行时与工具** | dispatcher 单工状态机(排队/挂起/恢复)、loop 策略(direct/reflective/plan-execute)、工具注册表+路径边界、cmd_run 白名单+高危审批、审批队列与卡片 | dev 角色执行"读文件→写私有区→提交 doc"全链路；高危命令弹审批，批准后执行；改动记录归档 | ① 派 dev 角色"读 workdir 某文件并总结"→ 工具调用轨迹可见；② 让 dev 执行高危命令(如 rm -rf 目录) → 弹审批卡，拒绝不执行、批准后执行；③ Agent 状态(空闲/工作中/等待中)随动 |
| **M4 产出物提交制** | 静态产物提交(校验/拷贝/manifest/版本/回退+versionDir 快照，H2)+ 代码受控编辑**任务级**聚合(D14-⑧)+ 产出物面板 | 提交 PRD → workdir/docs 出现；回退恢复内容一致；右栏 manifest 正确；改动记录归档 | ① dev 提交 doc 产物 → workdir 出现文件、manifest 版本=1；② 修改后提交 v2 → 回退到 v1 → workdir 内容与 v1 一致；③ 右栏产出物面板列表正确 |
| **M5 记忆与检索** | 会话滚动摘要、L3 长期条目(角色/全局、提取规则)、会议纪要生成、倒排索引+搜索 UI、resume_context | 长会话后摘要生效、上下文构建省 token；搜索命中跳转；重启恢复含摘要；改动记录归档 | ① 长会话产生 summary 事件、meta.summaryRefs 增长；② 搜索关键词命中并跳转到原文位置；③ 重启后上下文恢复含摘要 |
| **M6 会议机制** | meeting 发起/入会(单工挂起)/轮次引擎/用户决策点阻塞/插话/结束纪要回写、会议 UI | 复现验收脚本中"会议阻塞等用户拍板→答复→纪要回写"；改动记录归档 | ① PM 发起会议邀请 dev → 成员接受入会、各自 user 会话挂起；② 主持人提问到需用户拍板 → 阻塞卡片 → 用户答复 → 继续；③ 结束会议 → 纪要生成并回写各参与记忆 |
| **M7 工作台完善** | 三栏布局完善(左状态徽标/中聊天与会议/右 tabs)、未读、重连增量、深色主题、导出 zip | 全程 UI 操作完成 M0~M6 演示，无需手敲 API；改动记录归档 | ① 纯 UI 走通"建项目→对话→提交→会议→拍板→纪要"；② 断线重连增量不丢消息；③ 导出 zip 含会话/记忆 |
| **M8 质量与交付** | 测试补全、README 落地、打包、真实模型(DEEPSEEK/Ollama)验收、权限策略配置验证 | `npm run test` 全绿；真实模型跑验收主路径（prd §9）；改动记录归档 | ① `npm run build && npm run start` 单端口运行全流程；② 配置真实模型 Key 后主路径验收通过；③ 各策略开关按预期生效 |

## 3. 纵向切片建议（M0 之后推荐按以下切片推进）

- **切片 A（M1→M2 打通）**：创建项目 → 与 PM 用 Mock 对话（覆盖 会话/session log/单轮回复）。最先让"能聊天、能落盘、能恢复"成立。
- **切片 B（M3→M4 打通）**：dev 角色执行真实任务：写私有草稿→提交文档产物→命令执行(带审批)→回退。覆盖工具与安全主线。
- **切片 C（M5→M6 打通）**：记忆与会议：长会话摘要、PM 发起两方会议、阻塞拍板、纪要回写。
- 每个切片结束做一次 prd §9 验收主路径的回放，发现设计缺陷立即回改设计文档（改动记录同步）。

## 4. 阶段 M0 方案（当前阶段：执行中，完成即交用户验证）

- **改动范围**：仓库脚手架（package.json/tsconfig/ESLint/Prettier/config.yaml）+ src/{shared,infra,application,server} 首层 + `tests/`；不改动既有 docs 设计正文（仅本 plan 文档状态与修改记录）。
- **实现步骤**：
  1. 脚手架与依赖（fastify/yaml + typescript/tsx/vitest/eslint/prettier）。
  2. shared 层：错误码常量+AppError（对齐 api/contract.md §4）、config.yaml 加载(默认值合并)、schema 类型（project.json v1、fs browse 条目）。
  3. infra/util：id(前缀 p_/u_/a_/t_/ap_/s_)、UTC 时间、分级日志。
  4. infra/file-store：`atomicWriteFile/atomicWriteJson`（临时文件+rename，Windows 兼容）、`readJson`、路径边界 `ensureInside(root, target)`（防穿越、大小写归一卷绝对路径）。
  5. application/project：ProjectService——create(校验 name/workdir 存在为目录绝对路径)/list/get/patch(名称与描述)/remove(仅删运行时目录，不动 workdir)；运行时路径 `data/projects/<pid>`。
  6. application/fs-browse：用户级目录浏览（绕过 Agent 沙箱；过滤隐藏与已知系统目录、限深、Windows 属性兼容），M8 定稿。
  7. server：Fastify 应用组装 + 统一错误映射 `{code,message}` + REST 路由（projects CRUD、fs/browse、config）+ index.ts 启动(:3000, 127.0.0.1)。
  8. 测试：config 默认/覆盖；file-store 原子写与越界拒绝；ProjectService 建列改删（临时目录）；fs browse 过滤；API 集成(fastify inject)。
  9. 修改记录 + 验证 + 交用户确认。
- **关键伪代码**：
  ```
  atomicWriteFile(p, data): tmp = p + '.tmp-' + rand; write tmp; rename(tmp, p)
  ensureInside(root, target): abs(root), abs(target) 大小写归一化 → target === root 或 target.startsWith(root + sep)
  createProject(input): validateName; workdir 绝对且为目录 → mkdir dataDir/projects/<id> → atomicWriteJson(project.json, schema v1) → return dto
  removeProject(id): 校验存在 → rm(data/projects/<id>)（只删运行时文件夹，绝不触碰 workdir）
  browse(path, depth): normalizeAbs → stat 为目录 → readdir → 过滤隐藏/系统目录 → 目录在前、附 size/mtime；depth>1 递归且受限
  server: fastify; setErrorHandler(映射 AppError → code/message); routes 见下
  ```
- **验证方式**：`npm run test` 全绿；`npm run dev` 起服后按 §2 M0 行用户验证清单逐条执行。本机 3000 端口被占用时可改 config.yaml `server.port` 后重试。
- **沙箱环境备注**：agent 执行沙箱禁止子进程/命名管道 spawn（tsx/esbuild 与 vitest fork 不可用），故沙箱内验证用 `npx vitest run --pool=threads` 与 `npm run build && node dist/server/index.js`；用户本机 `npm run dev`/`npm run test` 不受影响。

## 5. 阶段 M1~M8 方案（进入各阶段时细化并同样走确认闸门）

M1~M8 各阶段进入时，按 §0 协议在本文件追加该阶段的「改动范围/实现步骤/验证方式」小节（或独立 docs/plan/ 阶段方案文件并回链），编码、记录、验证、交用户确认后进入下一阶段。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 上下文窗口/token 失控 | 摘要滚动 + 窗口裁剪（M5）；contextLimits 配置；检索注入上限 |
| 异步会议逻辑复杂（轮次+阻塞+插话交错） | 会议状态机先纯函数建模+大量单测（M6 前置）；**MVP 同一项目同一时刻至多 1 个进行中会议**（D14-⑥，新发起排队，实现与心智都最简）|
| Agent 工具越界/误操作真实目录 | 目录边界强制校验（M0 就绪）+高危审批+全审计；命令 cwd 恒 workdir |
| 长任务把单工卡死 | 可中断点设计 + 回合停顿汇报；用户可"打断"入队优先处理 |
| 模型质量导致产出混乱 | Mock 先行自动化；每角色默认 loop 与模型建议表；反思策略兜底 |
| 记忆与日志文件膨胀 | 轮转(5 万行)+索引可再生+导出清理 |

## 7. 每步验证方式

- 单元：domain 状态机/规则/解析（无 IO）。
- 集成：file-store 原子写与边界；session 落盘回读；审批流；会议状态流（Mock 模型）。
- 端到端：验收脚本（prd §9）人工走查 + Playwright（P1）。
- 命令：`npm run test`、`npm run dev`、`npm run build && npm run start`。
