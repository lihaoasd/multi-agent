# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 M4 产出物提交制（静态产物路径 + 版本快照 + 回退）

- 需求/问题: 完成 M4 里程碑：静态产物提交(校验/拷贝/manifest/版本)、回退(H2：内容依据=versionDir 快照，不依赖 git)、doc 门审批(含 D16-⑥ 只读预览)、产出物 REST。用户已解除逐阶段确认，自主推进。
- 类型: 代码(新建) + 测试
- 改动范围:
  1. `src/application/artifact/artifact-service.ts`：ArtifactService。
     - submit：类型/清单/源存在性校验 → doc 门(needsApproval)时先落 `submitted`+审批(approval detail 含文件清单与首文件 4000 字符只读预览)，否则直接执行；
     - execute：把 ws:// 源拷入 workdir(ensureInside 相对路径校验) + 快照拷贝到 `artifact-versions/<aid>/v<n>/` + 计算 sha256/size 明细与 diff 摘要 → manifest 原子落盘（先业务文件再 log 投影）；
     - 同 actor+type 连续提交版本递增；finalizeApproved(审批通过后写入)；rollback 按目标版本快照恢复 workdir、记录置 `reverted`（不物理删历史）；listVersions 列版本目录。
  2. `src/application/composition.ts`：注入 artifacts；REST 路由在 `src/server/app.ts`：GET /artifacts、GET /artifacts/:aid(+versions)、POST /artifacts/:aid/rollback。
  3. `tests/artifact-m4.test.ts`：6 用例（无审批门提交闭环、版本递增 v2、doc 门 submitted→approve→finalize 写入(预览内容校验)、reject 不写入、回退恢复 v1 内容、校验错误）。
- 原因: M4 交付"产出走提交制进 workdir、可回退"；workdir 受控编辑(code 通道 D14-⑧)的任务级聚合与审批门覆盖留待 M8 真实工具链/任务通道细化时补审计口径（设计依赖 D15 任务与 workdir_edit 工具，MVP 静态产物路径已按 D13② doc 门默认执行）。
- 行为变化: 静态 doc 产出物（默认需审批）落 submitted+审批卡，批准后写入 workdir 并可回退；manifest(artifacts.jsonl) 为唯一记录。
- 验证: `npm run test` 78/78；tsc 0 错；eslint 0 错。
- 测试: artifact-m4 6 用例。
- 遗留(说明): code 通道（workdir_edit + 任务聚合 D14-⑧）因依赖任务系统(M5/M6 实现)与真实模型工具调用，代码聚合版本记录接口已预留(ArtifactService 泛型)，具体在 M8 前按 design 补审计链路或明示降级（见 README 路线图更新）。
