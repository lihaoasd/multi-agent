# 工具包设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D19-②、prd FR-26/US-15
> 关联：[tools.md](tools.md)（工具注册表真源）、[agent-templates.md](agent-templates.md)（Agent 挂载）、[ui.md](ui.md)（首页工具模块）、[contract.md](../api/contract.md)

## 1. 定位

- **工具**是 Agent 影响外部世界的唯一通道（见 tools.md §1）；**工具包（package）** 是工具的组织单位：把同域工具打成一包，供首页展示、供 Agent 挂载、供未来扩展第三方工具。
- 权威关系：**工具注册表（tools.md §2/§3）是工具的真源**；本文件只定义"分组与挂载"，不重复工具清单细节。
- MVP 只做**展示**：不可在 UI 里制作/编辑/卸载工具包（制作功能后续，见 §6 未决）。

## 2. 包模型

```jsonc
{
  "id": "artifact",              // 包 id（= 工具域前缀，全局唯一）
  "name": "产出物",              // 展示名
  "description": "工作目录受控编辑与产出物登记/回退",
  "tools": ["workdir_edit", "artifact_submit", "artifact_rollback"],   // 包内工具（注册表校验存在性）
  "riskMax": "low",              // 包内最高风险（none|low|high）
  "network": "none",             // 包内最高网络需求
  "required": true,              // MVP：8 个基础包均为 true（全员必选，D19-②；S13 起含 interaction）
  "version": "1.0.0",
  "source": "builtin"            // builtin | custom（custom 为后续能力）
}
```

- 工具侧对应字段：每个工具在注册表里声明 `package`（见 tools.md §2），包内 `tools[]` 与工具侧 `package` 必须互相一致（启动自检）。
- `required=true` 的包不可被任何角色取消挂载；MVP 里 8 个包全为必选，因此**包不影响现有授权链**（角色白名单 × 会话类型 × allowedRoots × 归属校验照旧生效）。

## 3. 内置基础包（MVP：8 个）

| 包 id | 名称 | 工具 | 说明 |
| --- | --- | --- | --- |
| `fs` | 文件读写 | `fs_read_file`、`fs_list_dir`、`fs_search` | 工作目录 + `ro://` 只读；工作目录内容全员可读 |
| `cmd` | 命令执行 | `cmd_run` | 结构化 argv，cwd 锁定在 workdir；风险分级 + 审批 |
| `memory` | 记忆 | `memory_search`、`memory_append`（own） | 角色记忆读写 + 全局记忆检索 |
| `session` | 会话检索 | `session_search` | 本项目会话日志检索（受可见性规则约束） |
| `artifact` | 产出物 | `workdir_edit`、`artifact_submit`、`artifact_rollback` | 工作目录唯一写通道 + 登记/回退 |
| `approval` | 审批 | `approval_query` | 查看自己触发的审批状态 |
| `task` | 任务 | `task_view`、`task_list`、`task_assign`、`task_claim`、`task_update` | 任务查看/委派/领取/汇报（`task_assign` 受编排图出边约束） |
| `interaction` | 交互 | `ask_user` | 向用户提问并阻塞等待答复（Agent 唯一的人工决策通道；**S13 从 `task` 包独立出来**） |

> 上表是 MVP 的稳定集合；新增工具时优先归入已有包，确需新域再新增包（同时更新本表与 tools.md）。
> 归属一致性：工具注册时的 `package` 字段必须与声明它的包相同（`tests/integration/server/tool-packages-api.test.ts` 双向断言）。

## 4. 挂载与生效

- **Agent 侧字段**（模板与实例）：`packages: ["fs","cmd",…]`（MVP 由模板快照写入，全部为基础包）。
- 生效链路保持单链：`实例配置（tools/packages 快照）` → `loop runner 的可用性校验` → `PolicyEngine` 审批判定 → `ToolExecutor` 执行。
- 包的**展示态**与**生效态**必须可区分：UI 上"挂载但运行期不可用"的工具单独标注（例：白名单里有、注册表已无）。

## 5. 展示契约（MVP）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/tool-packages` | 包列表（含 `tools[]` 展开、`required`、`source`） |
| GET | `/api/tool-packages/:packageId` | 单包详情（含每个工具的作用/风险/网络/幂等/适用会话） |

- 数据来源：内置包元数据随仓库（`src/infra/tools/packages.ts`，只读；S4 起从 `shared/` 迁到 `infra/` 以满足分层约束）；用户自定义包目录 `data/packages/<packageId>/` 为后续能力（当前仅预留，不读取不展示）。
- UI 呈现见 [ui.md](ui.md) §2.4（工具模块）。

## 6. 扩展位与未决

| # | 待定 | 说明 |
| --- | --- | --- |
| U8 | 自定义工具包 | 制作/编辑/删除、包 `manifest`（id/name/version/tools[]/entry）、安装目录、校验与冲突策略 |
| U11 | 第三方 / MCP 式外部工具 | 外部进程/远端工具接入、来源信任、权限与审批、失败隔离（不引重型依赖是既定原则） |

设计约束（对后续版本的硬要求，现在不实现）：
1. 自定义包**不得**绕过工具注册表与 `PolicyEngine`：所有工具仍须注册后才可被调用；
2. 包安装/卸载属**高危动作**，需用户审批并留审计；
3. 包版本与来源必须在 UI 可见（避免"来源不明的工具"悄悄获得文件/命令能力）。
