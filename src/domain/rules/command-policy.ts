/**
 * PolicyEngine 命令侧判定（domain/rules 纯函数，D18-⑥）。
 * 优先级 deny > approval > allow；与 tools.md §2、sandbox.md §5 规则表对应（MVP 子集）。
 */

export type Decision = 'allow' | 'approval' | 'deny'

export interface PolicyVerdict {
  decision: Decision
  ruleId: string
  reason: string
}

export interface AssessInput {
  program: string
  args: string[]
  offline?: boolean
}

function baseName(p: string): string {
  const b = p.split(/[\\/]/).pop() ?? p
  return b.toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, '')
}

/** 只读/查询类：直接 allow */
const READONLY = new Set([
  'ls',
  'dir',
  'cat',
  'type',
  'pwd',
  'find',
  'grep',
  'where',
  'which',
  'echo',
])

/** 构建/测试类：allow */
const BUILD_TEST = new Set([
  'tsc',
  'vitest',
  'jest',
  'eslint',
  'prettier',
  'webpack',
  'vite',
  'npm-run',
])

function verdict(d: Decision, ruleId: string, reason: string): PolicyVerdict {
  return { decision: d, ruleId, reason }
}

/** 命令风险判定（MVP 规则表）。 */
export function assessCommand(input: AssessInput): PolicyVerdict {
  const p = baseName(input.program)
  const a = input.args
  const first = a[0]?.toLowerCase()
  const joined = [p, ...a].join(' ').toLowerCase()

  // 1) 危险/逃逸 → deny
  if (p === 'curl' && (joined.includes('|') || first === 'sh')) {
    return verdict('deny', 'CURL_PIPE_SH', '下载并执行脚本（curl | sh），禁止')
  }
  if (p === 'sudo' || p === 'sc' || p === 'reg' || p === 'sc.exe') {
    return verdict('approval', 'SYSTEM_LEVEL', '系统级操作，需用户确认')
  }

  // 2) 高危 → approval
  if (p === 'rm' && (a.includes('-rf') || a.includes('-fr') || first === 'rm')) {
    return verdict('approval', 'RM_RF', '递归强制删除不可逆，需用户确认')
  }
  if (p === 'rm' && a.length > 0) {
    return verdict('approval', 'RM_FILE', '删除操作不可逆，需用户确认')
  }
  if (p === 'git' && first === 'push') {
    return verdict('approval', 'GIT_PUSH', '推送远程，需用户确认')
  }
  if (p === 'npm' && first === 'publish') {
    return verdict('approval', 'NPM_PUBLISH', '发布包对外生效，需用户确认')
  }
  if (p === 'npm' && (first === 'uninstall' || first === 'remove')) {
    return verdict('approval', 'NPM_UNINSTALL', '卸载依赖，需用户确认')
  }
  if (
    (p === 'git' || p === 'npm' || p === 'pnpm' || p === 'yarn' || p === 'curl' || p === 'wget') &&
    input.offline
  ) {
    return verdict('deny', 'NET_OFFLINE', '离线模式禁止联网动作')
  }

  // 3) 常见只读/构建/安装 → allow
  if (READONLY.has(p)) return verdict('allow', 'READ_CMD', '只读命令')
  if (BUILD_TEST.has(p)) return verdict('allow', 'BUILD_TEST', '构建/测试命令')

  if (p === 'git') {
    const readOnly = ['status', 'log', 'diff', 'branch', 'fetch', 'show', 'remote', 'config']
    if (readOnly.includes(first ?? '')) return verdict('allow', 'GIT_READ', 'git 只读查询')
    if (first === 'clone' || first === 'pull') return verdict('allow', 'GIT_FETCH', '拉取代码')
    return verdict('approval', 'GIT_OTHER', `git ${first} 需用户确认`)
  }
  if (p === 'node') {
    if (first === '--version' || first === '-v') return verdict('allow', 'NODE_VER', '版本查询')
    return verdict('allow', 'NODE_SCRIPT', '运行脚本（路径边界在 executor 层校验）')
  }
  if (p === 'npm' || p === 'pnpm' || p === 'yarn') {
    const okFirst = ['install', 'ci', 'run', 'test', 'build', 'add', 'exec', 'create']
    if (okFirst.includes(first ?? '')) return verdict('allow', 'PKGMGR', '依赖/脚本执行')
    return verdict('approval', 'PKGMGR_OTHER', `包管理器操作 ${first ?? ''} 需用户确认`)
  }
  if (p === 'python') {
    return verdict('allow', 'PYTHON_SCRIPT', '运行脚本')
  }
  if (p === 'powershell' || p === 'pwsh' || p === 'cmd') {
    return verdict(
      'approval',
      'SHELL_RAW',
      '自由 shell/脚本解释器，需用户确认（建议先写脚本文件再运行）',
    )
  }
  if (p === 'tsx' || p === 'npx') {
    return verdict('approval', 'NPX_TOOL', '临时工具执行，需用户确认')
  }

  // 4) 未知程序：默认 approval（宁可多问一次）
  return verdict('approval', 'UNKNOWN_PROGRAM', `未知程序 ${p}，需用户确认`)
}
