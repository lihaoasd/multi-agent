# 沙箱与命令执行安全设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D12（目录受限+高危审批）、补充确认（进程/文件级逻辑沙箱、默认联网+高危外联审批）、prd FR-13/§8、tools.md §6
> 关联：[tools.md](tools.md)、[agent-runtime.md](agent-runtime.md)（审批桥）、[workspaces-artifacts.md](workspaces-artifacts.md)（写通道）、[data-storage.md](data-storage.md)（审批/审计落盘）

## 1. 威胁模型与信任边界（先说清防谁）

- 环境：本机单用户、无 Docker 等额外运行时（已确认逻辑沙箱，Windows 可用）。
- 威胁主体不是"恶意攻击者"，而是**模型输出不可预测导致的误操作**：把 `rm -rf`、覆盖性安装、全局配置修改、对外发布等动作，当作无害操作执行。
- 信任假设：平台进程运行在用户自身权限下（不申请提权）；平台自身代码可信；**模型生成的一切工具参数都视为不可信输入**。
- 目标：任何 Agent 动作都满足「路径受限 + 风险分级 + 用户可控 + 全量审计」，且不破坏正常开发闭环（install/build/test 必须能跑）。

## 2. 分层沙箱总览（逻辑沙箱，四层 + 可插拔扩展）

```
L0 文件系统边界  虚拟路径(scheme) + 绝对路径规范化 + 符号链接校验 → 越界即拒
L1 进程执行控制  cwd 锁定 / 结构化 argv(无自由 shell) / 禁交互 / 超时杀进程 / 输出截断
L2 风险分级审批  命令与外联动作风险判定表 → allow | approval | deny
L3 审计          所有调用、审批决定、越界尝试落盘（会话 log + approvals.jsonl）
可选扩展         更强隔离后端 provider（Docker/受限账号/虚拟机）预留接口，默认关闭
```

## 3. L0 文件系统边界

### 3.1 虚拟路径方案（防混乱 + 边界校验一体）

Agent 看到的文件路径一律是逻辑路径，由平台映射：

| scheme | 含义 | 映射到 | 可写 |
| --- | --- | --- | --- |
| `workdir://<file>` | 项目工作目录（**全员可读**，写入按归属） | 用户选定 workdir 根 | 仅受控通道（tools.md §6） |
| `ro://<file>` | 只读平台资源 | 内置模板/公共只读内容 | ❌ |
| `runtime://` | 运行时项目数据 | 平台独占 | ❌（Agent 一律不可写；会话日志由平台写） |

### 3.2 解析与校验流程

```
scheme + rel → 候选根 → 拼接绝对路径 → 逐段解析符号链接(realpath)
  → 校验最终真实路径仍在「项目 workdir ∪ 允许的 ro 根」之内
  → 通过才交给文件工具；否则拒绝 { ok:false, code: FS_BOUNDARY }
```

- 绝对路径输入：先强制转 scheme（落到边界内才接受），不接受 `../` 逃逸或盘符跳转。
- 符号链接：解析全程跟随并检查每一段，防链接指向 workdir 外。
- **共享与归属**：工作目录内容对**所有角色可读**（不设隔离区）；写入由工具层按 `file-owners` 校验——只能写归属自己或无归属的文件，他人产出物拒改（`ERR_FORBIDDEN`），越界/越权尝试按审计记录（不静默）。
- 例外只读：工作目录之外的**平台只读资源**（角色模板等）经 ro:// 显式开放，不放开任意路径读取。
- **工具级可用根（L0 是底线而非放权）**：L0 允许"workdir ∪ ro"，但各工具可用的根由注册表声明收窄——`fs_*` 仅 workdir+ro://（读取全员开放）；写入仅 `workdir`，且另受归属校验（见 workspaces-artifacts §2）。

## 4. L1 进程执行控制（cmd_run）

### 4.1 调用形态：结构化 argv，非自由 shell

```jsonc
// cmd_run 参数（模型只能产出结构化 JSON，无法拼 shell 注入串）
{ "program": "npm", "args": ["run", "test"], "cwd": "workdir://", "env": null, "timeoutMs": 120000 }
```

- 优先 `spawn(program, args)` 且 **shell=false**：不给模型可拼接的 shell 字符串入口。
- Windows 兼容：`npm`/`.bin/*.cmd` 解析为真实可执行（`npm.cmd` 等）再 spawn；不经用户 shell profile；git-bash/全局 shell 不放开。
- 特殊需要 shell 语义（管道/重定向）的动作：按命令形状白名单特判（如 `git log | head` 拆成查询+截断），不做自由 shell 工具；确需脚本时要求 agent 先用 `workdir_edit` 在工作目录内写好脚本文件（受控编辑、署名留痕）再以 `node script.js` 运行。
- `cwd` 必须落在 workdir 内（可子目录）；`env` 仅透传白名单变量（PATH/HOME 等），**不注入密钥/API Key**。**密钥类操作（M14b 定稿）**：涉及密钥的发布/推送/上传命令平台**不自动执行**——prd §8 已排除生产部署自动化，MVP 一律提示用户手动运行；"审批后临时注入密钥并脱敏"留待后续迭代（届时仅限审批通过的单次注入白名单变量、审计脱敏、进程内不留存）。

### 4.2 进程硬约束

| 约束 | 默认 | 说明 |
| --- | --- | --- |
| stdin | 关闭 | 命令不可交互，防挂起（提示类命令不可用） |
| 超时 | 60s（可配置上限 10min） | 到点杀进程树（Windows: taskkill /T）；长构建超时可向用户申请提高额度（low 审批） |
| 长驻/服务 | 禁止 | 检测到监听型/daemon（dev server/watch）→ 拒绝并提示"请用户自己运行或后续用后台任务托管（P1）" |
| GUI/新窗口 | 禁止 | 不启动桌面程序 |
| 并发 | 每 Agent 串行 | 同 Agent 命令排队；跨 Agent 各自串行，写 workdir 的冲突由**文件编辑会话锁**（ERR_CONFLICT，workspaces-artifacts §5）与受控通道约束兜底 |
| 输出 | 截断保留尾部（默认 12KB，可配置） | 防大日志灌爆上下文 |

## 5. L2 风险分级与审批

### 5.1 判定引擎

输入 = program 基名 + args 模式 + 动作网络语义；规则表为**声明式配置**（`.env` / 项目覆盖 / 角色可收紧），输出：

> 统一策略入口（D18-⑥）：本节 L2 判定是 **PolicyEngine** 的命令侧数据源；与 tool 元数据 needsApproval、project.json 策略、信任开关（D17-④）合并后输出最终 allow/approval/deny，优先级 **deny > approval > allow**（见 tools.md §2）。

```
{ decision: "allow" | "approval" | "deny", ruleId, reason }
```

内置规则（示例，可扩充）：

| 规则 | 示例命令 | 判定 |
| --- | --- | --- |
| 查询/只读 | git status/diff/log(本地)、ls、cat、node --version | allow（留审计） |
| 构建/测试 | npm run build/test、tsc、vitest、npm ci/install | allow（默认联网） |
| 清理可再生 | 删除 node_modules/dist、清缓存 | allow（明确单路径非递归根目录时） |
| 不可逆删除 | rm -rf 根/项目根/仓库目录、格式化 | **approval** |
| 覆盖性变更 | npm uninstall/全局安装、覆盖 package.json/锁文件大改、改平台 config | **approval** |
| 提权/系统级 | 改系统服务、权限变更(chmod -R / 提权命令)、写 workdir 之外 | **approval/deny** |
| 外联高危 | git push 到远程、npm publish、上传/发布、`curl … \| sh` 下载即执行 | **approval**（见 §6） |
| 明显恶意/逃逸 | 试图改沙箱外路径、下载执行组合、反弹类 | **deny**（拒 + 审计） |

> 判定是**白名单+黑名单叠加**：未知 program 默认 approval（宁可多问一次，本地个人使用成本可接受）。

### 5.2 审批桥（与 agent-runtime.md §6/§7 一致）

- 命中 approval → 生成审批记录（kind=command，含命令/参数摘要/影响/来源会话/风险规则）→ 推用户审批卡片。
- Agent 置 waiting；批准 → 执行并把结果回注；拒绝 → `{ok:false, code:APPROVAL_REJECTED}` 回注，Agent 必须调整方案或说明。
- 审批全部落盘 approvals.jsonl + 会话 log（audit 双写）。
- **跨重启语义（M1 定稿）**：进程内批准=执行器续跑原调用；若等待期进程重启，approval 保持 `pending`，用户决定只落盘不回放执行，Agent 恢复后读取决定自行决定是否重试（重试命中审批需重新审批）。详见 agent-runtime.md §7。
- 用户可对同一命令签名"记住放行 N 次/永久"（存项目级配置，仍可撤销）——P1 优化，MVP 每次确认。

## 6. 联网策略（已确认：默认联网 + 高危外联审批）

| 类别 | 例 | 判定 |
| --- | --- | --- |
| 常规拉取 | npm install/ci、git clone/fetch、下载依赖到缓存 | allow（默认联网） |
| 高危外联 | git push、npm publish、上传文件/数据、下载并执行脚本 | **approval** |
| 后台驻留外联 | 启动对外服务/监听端口 | 拒绝（长驻禁令，见 §4.2） |

- 网络命令照样留审计（目标主机/URL 摘要，密钥脱敏）。
- config 提供 `sandbox.network: online | offline`：offline 时一切网络动作 deny（完全离线开发）。
- 判定依据命令形状 + 外联关键字；无法可靠识别的网络动作默认 approval。

## 7. L3 审计

- 统一审计事件（会话 log kind）：`tool_call`（含结构化参数摘要）、`tool_result`（含结果摘要/截断标记）、`approval_request/result`、`error`（含 FS_BOUNDARY/APPROVAL_REJECTED/TIMEOUT 等 code）。
- 越界尝试与 deny 也记录（不静默）；审计不存敏感原文（命令环境变量注入值脱敏）。
- UI：会话内工具卡可展开审计详情；"审计轨迹"=按 kind 过滤的事件流（api/contract.md）。

## 8. 失败行为总表（Agent 视角）

| 结果 | code | Agent 应 |
| --- | --- | --- |
| 路径越界 | FS_BOUNDARY | 改用合法 workdir/ro 路径 |
| 需审批 | APPROVAL_REQUIRED(→waiting) | 等待用户；说明目的 |
| 用户拒绝 | APPROVAL_REJECTED | 调整方案或征询替代做法 |
| 命令超时被杀 | CMD_TIMEOUT | 缩小范围/分批执行/申请更长额度 |
| 长驻禁止 | CMD_FORBIDDEN_DAEMON | 说明需要用户手动运行 |
| 网络断开线 | NET_OFFLINE | 说明需联网或换离线方案 |
| 未知程序 | APPROVAL_REQUIRED | 换已知工具或解释必要性 |

## 9. 与产出物提交制的关系（三通道，见 tools.md §6）

命令副作用（③）允许写入 workdir（npm install 等），与 `workdir_edit`（①）、`artifact_submit`（②）并列为三种受控写；工具层无第四条自由写通道。正式代码变更以 ① 的审计聚合为准（D13①），命令产生的运行副产物不属于 artifact 文件清单。

## 10. 测试与验收要点（落实进 testing/plan.md）

- 单元：路径解析（../、盘符、symlink 链、scheme 混用）、危险规则表判定、超时杀进程、env 白名单/密钥不注入。
- 集成：审批拒绝→回注→Agent 换方案（Mock 剧本）；越界调用被拒并审计；npm install 在 workdir 正常执行且留痕。
- 验收脚本片段：让 dev Agent `cmd_run` 尝试删除 workdir 根目录 → 弹审批 → 拒绝 → 无任何删除且审计有记录；让另一角色尝试改 dev 归属的文件 → `ERR_FORBIDDEN`（点名 owner）；读他人文件正常放行（共享可读）。
