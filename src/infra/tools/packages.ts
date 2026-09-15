import type { ToolPackageInfo } from '../../ports/tools'

/**
 * 内置工具包元数据（D19-②：7 个基础包全员必选）。
 * ⚠️ 这里是**声明**（展示态）；运行期是否可用取决于 `ToolRegistry` 里是否真的注册了对应工具
 * （S4 实现 fs/cmd/approval，S5 实现 memory/session，artifact/task 随 S6 落地，UI 按"挂载但运行期不可用"标注）。
 *
 * 位置说明：包元数据是**适配器数据**（要引用 ports 的 `ToolPackageInfo` 类型），因此放 infra 而非 shared
 * （shared 层不得依赖其它层，abstraction §2；由依赖门禁强制）。
 */
export const BUILTIN_TOOL_PACKAGES: readonly ToolPackageInfo[] = [
  {
    id: 'fs',
    name: '文件读写',
    description: '工作目录与只读平台资源的读取（写入通道见产物包）',
    tools: ['fs_read_file', 'fs_list_dir', 'fs_search'],
    riskMax: 'none',
    network: 'none',
    required: true,
    source: 'builtin',
  },
  {
    id: 'cmd',
    name: '命令执行',
    description: '结构化 argv 执行，cwd 锁定工作目录；风险分级 + 审批',
    tools: ['cmd_run'],
    riskMax: 'high',
    network: 'allowed',
    required: true,
    source: 'builtin',
  },
  {
    id: 'memory',
    name: '记忆',
    description: '角色长期记忆读写与全局记忆检索',
    tools: ['memory_search', 'memory_append'],
    riskMax: 'none',
    network: 'none',
    required: true,
    source: 'builtin',
  },
  {
    id: 'session',
    name: '会话检索',
    description: '本项目会话日志检索（受可见性规则约束）',
    tools: ['session_search'],
    riskMax: 'none',
    network: 'none',
    required: true,
    source: 'builtin',
  },
  {
    id: 'artifact',
    name: '产出物',
    description: '工作目录受控编辑与产出物登记/回退',
    tools: ['workdir_edit', 'artifact_submit', 'artifact_rollback'],
    riskMax: 'low',
    network: 'none',
    required: true,
    source: 'builtin',
  },
  {
    id: 'approval',
    name: '审批',
    description: '查看自己触发的审批状态',
    tools: ['approval_query'],
    riskMax: 'none',
    network: 'none',
    required: true,
    source: 'builtin',
  },
  {
    id: 'task',
    name: '任务',
    description: '任务查看/委派/领取/汇报（委派受编排图出边约束）+ 向用户提问（ask_user）',
    tools: ['task_view', 'task_list', 'task_assign', 'task_claim', 'task_update', 'ask_user'],
    riskMax: 'low',
    network: 'none',
    required: true,
    source: 'builtin',
  },
]

export const TOOL_PACKAGE_IDS = BUILTIN_TOOL_PACKAGES.map((item) => item.id)
