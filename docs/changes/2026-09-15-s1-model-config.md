# 修改记录 · S1 模型配置模块 + Agent 配置提交（2026-09-15）

> 类别：changes · 类型：**实现** · 方案：[docs/plan/2026-09-15-s1-model-config.md](../plan/2026-09-15-s1-model-config.md) · 总计划：[development.md](../plan/development.md) §5
> 需求来源：用户"开始全部开发"（按开发计划 S0~S9 实现 MVP）；本轮落地 FR-34 / FR-35（US-22 / US-23）

## 1. 交付内容

| 层 | 新增/修改文件 |
| --- | --- |
| 端口 | `ports/file-store.ts`、`ports/model.ts`、`ports/model-config.ts`、`ports/role-templates.ts`、`ports/events.ts`；`ports/tokens.ts`（5 → 12 个 Token） |
| 数据 | `shared/model-presets.yaml`（9 家 + mock）、`shared/roles/*.yaml`（pm/product/architect/ux/ui/dev/qa/ops）、`shared/loop.ts` |
| infra 存储 | `infra/file-store/file-store.ts`、`infra/file-store/model-config-store.ts`、`infra/file-store/role-template-store.ts` |
| infra 模型 | `infra/model/{stream,json,http,redact,gateway,registry,presets}.ts`、`infra/model/providers/{openai-compatible,anthropic,gemini,ollama,mock}.ts` |
| infra 平台 | `infra/config/secret-resolver.ts`、`infra/config/env-config.ts`（+`loadEnvMap`）、`infra/events/noop-broadcaster.ts` |
| application | `application/model-config/{catalog,validate,dto,references,service}.ts`、`application/team/{validate-agent-config,agent-config-service}.ts` |
| server | `server/http-routes/{model-config,agent-templates,parse}.ts`；`server/app.ts` 接收装配好的服务 |
| bootstrap | `composition-root.ts`（装配 12 端口 + 2 服务 + 广播器；启动自检预置目录）、`main.ts`（`loadEnvMap` + 初始化） |
| 前端 | `web/src/api/{client,modelConfig,agentTemplates}.ts`、`web/src/pages/{ModelModule,AgentModule}.tsx`、`web/src/App.tsx`（四模块导航） |
| 测试 | `tests/helpers-server.ts` + `tests/unit/infra/{model-config-store,model-adapters,secret-resolver}.test.ts` + `tests/integration/server/{model-config-api,model-config-import,agent-templates-api}.test.ts` |

## 2. 关键决定（可推翻）

1. **`loadEnvMap()` 统一 `.env` 读取**：`.env` 内容不写回 `process.env`，所以配置解析 / env 凭证 / 遗留导入共用"文件 + 进程环境"合并映射。**这是本轮实测踩到的两类真实缺陷**：① 首次启动不触发 `MODELS__PROVIDERS` 导入（只读 `process.env`）；② env 模式凭证永远显示"未设置"。修复后有单测与集成测试各一条守着。
2. **首次初始化兜底内置 Mock**：空配置经"导入 → 仍为空"后自动创建 `mock` 供应商 + 模型并设为默认，保证 prd §9 验收 2「无 Key 跑通」在**出厂状态**即成立。
3. **`ModelCatalog.current()` 放进端口**：避免服务层为拿快照再开一条读盘路径；`ModelCatalogWithConfig` 这一层临时类型在实现中被删除（不留双口径）。
4. **凭证解析边界**：`file` 空值 → `null`（mock/ollama 合法），真实供应商"必须有密钥"由创建/编辑校验负责；`env` 缺失保存即失败。
5. **模板层先行**：实例覆盖需要 ProjectStore（S2），本轮交付模板层三项 + 共用校验器 `validate-agent-config.ts`，S2 接 `team/:iid` 时零重复实现。
6. **内置模板不可修改也不可停用**（`ERR_FORBIDDEN`）——比设计原文更严一档：停用同样属"原地变更"，故要求复制新建；已回写 `model-config.md` §8 #15 与 `contract.md`。
7. **批量登记 id 归一化**：`<providerId>-<模型名>` 净化（小写、非法字符转 `-`、去重后缀），火山方舟这类无法枚举的供应商走手工单条创建。

## 3. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 类型检查（服务端 + 前端） | 0 错误 |
| 测试 | **12 files / 83 tests 全通过**（新增 46 条：适配器归一化 9、模型配置存储 9、凭证解析 4、模型配置 API 10、遗留导入 3、Agent 模板 API 9，其余为 S0 存量） |
| 依赖门禁 | `eslint .` exit 0；ratchet 越层违规 0 处（基线 0） |
| 真实服务验收（prd §9 验收 8） | 全部通过：首次启动从 `.env` 导入 `deepseek-flash`（`credential.mode=env`、`hasValue=true`）→ 预置新增 Ollama → mock 测试连接 200 / 发现 200 → 批量登记 2 条（id 归一化）→ 路由非法 400、合法 200 → 删除被引用供应商 409 → 内置模板 8 个 → 改内置 403 → 复制新建 201 → 三项提交 200 → loop 越界 400 → 历史快照 2 份 |
| 密钥卫生 | 接口响应、`data/model-config.json`、`config-audit.jsonl` 均无明文密钥（`env` 模式只存变量名，接口只回 `masked`/`hasValue`） |
| 失败路径 | 本机无 Ollama 时 `GET .../discover` → 502 `ERR_MODEL`（网络错误归一化 + 脱敏） |
| 前端 | `vite build` 成功；`GET /` 返回 SPA 且引用新产物 hash；`web/tsconfig` 与 eslint（含"前端不得引服务端源码"）均通过 |
| 遗留迁移 | `data/model-config.json`（v0 形状）被备份为 `data/model-config.v0.bak.json` 后按空配置启动 |

## 4. 未做 / 遗留

- **实例层配置**（`PATCH /api/projects/:pid/team/:iid`）留 S2：需要 ProjectStore；`EffectiveAgentConfigResolver.invalidate` 与 `configVersion+1` 的生效机制已在设计中就位。
- **WS 真实网关**留 S3：本轮只落 `EventBroadcaster` 端口与广播调用点，`model-config.updated` / `agent-config.updated` 已有测试断言，S3 换实现即生效。
- 未做：U13 用量统计、U14 密钥加密、U15 配置回滚 UI、U16 代理、U9 剩余（工具挂载编辑）。
- 每阶段的真实供应商连通性（DeepSeek/OpenAI 等）未做联网验证（避免消耗用户额度）；`mock`/`ollama` 两个离线后端已覆盖成功与失败路径。
- 端口 3000 仍被 14:29 启动的旧实例占用（非本轮启动），验收统一用 3100。

## 5. 回滚

```bash
git rm -r src/ports/{file-store.ts,model.ts,model-config.ts,role-templates.ts,events.ts} \
  src/infra/model src/infra/file-store/model-config-store.ts src/infra/file-store/role-template-store.ts \
  src/application src/infra/config/secret-resolver.ts src/infra/events src/shared/model-presets.yaml src/shared/roles \
  web/src/pages web/src/api/{client,modelConfig,agentTemplates}.ts \
  tests/unit/infra/model-adapters.test.ts tests/integration/server/model-config-*.test.ts \
  tests/integration/server/agent-templates-api.test.ts tests/helpers-server.ts
git checkout HEAD -- src/ports/tokens.ts src/infra/config/env-config.ts src/server/app.ts src/bootstrap/composition-root.ts \
  src/bootstrap/main.ts web/src/App.tsx docs/README.md docs/api/contract.md docs/design/model-config.md \
  docs/design/data-storage.md docs/plan/development.md
```
（`data/` 为运行时数据且不入库，回滚无需处理。）
