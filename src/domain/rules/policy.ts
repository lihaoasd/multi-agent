import type { PolicyEngine, PolicyInput, PolicyOutcome } from '../../ports/policy'

/**
 * 统一策略引擎（纯函数，D18-⑥）：
 * **优先级 deny > approval > allow**；规则以数据源（工具元数据 / 命令风险表 / 项目策略 / 信任开关）驱动。
 * 只返回判定，不产生副作用（审批记录、事件、审计由调用方落）。
 */

export interface CommandRisk {
  readonly level: 'none' | 'low' | 'high' | 'deny'
  readonly ruleId: string
  readonly reason: string
  /** 是否出网（离线模式下直接 deny） */
  readonly network: 'none' | 'outbound'
}

const DENY_PROGRAMS = new Set(['format', 'diskpart', 'mkfs', 'mkfs.ext4', 'fdisk', 'shutdown', 'reboot', 'halt', 'poweroff'])

const HIGH_RISK_PROGRAMS: readonly { readonly program: string; readonly ruleId: string; readonly reason: string }[] = [
  { program: 'rm', ruleId: 'CMD_RM', reason: '删除文件/目录' },
  { program: 'rmdir', ruleId: 'CMD_RMDIR', reason: '删除目录' },
  { program: 'del', ruleId: 'CMD_DEL', reason: '删除文件' },
  { program: 'erase', ruleId: 'CMD_DEL', reason: '删除文件' },
  { program: 'remove-item', ruleId: 'CMD_REMOVE_ITEM', reason: '删除文件/目录（PowerShell）' },
  { program: 'rd', ruleId: 'CMD_RMDIR', reason: '删除目录' },
  { program: 'kill', ruleId: 'CMD_KILL', reason: '终止进程' },
  { program: 'taskkill', ruleId: 'CMD_KILL', reason: '终止进程' },
  { program: 'stop-process', ruleId: 'CMD_KILL', reason: '终止进程（PowerShell）' },
  { program: 'chmod', ruleId: 'CMD_CHMOD', reason: '修改权限' },
  { program: 'chown', ruleId: 'CMD_CHOWN', reason: '修改归属' },
  { program: 'npm', ruleId: 'CMD_INSTALL', reason: '可能安装依赖' },
  { program: 'pnpm', ruleId: 'CMD_INSTALL', reason: '可能安装依赖' },
  { program: 'yarn', ruleId: 'CMD_INSTALL', reason: '可能安装依赖' },
  { program: 'pip', ruleId: 'CMD_INSTALL', reason: '可能安装依赖' },
  { program: 'pip3', ruleId: 'CMD_INSTALL', reason: '可能安装依赖' },
  { program: 'apt', ruleId: 'CMD_INSTALL', reason: '系统包管理' },
  { program: 'apt-get', ruleId: 'CMD_INSTALL', reason: '系统包管理' },
  { program: 'brew', ruleId: 'CMD_INSTALL', reason: '系统包管理' },
  { program: 'choco', ruleId: 'CMD_INSTALL', reason: '系统包管理' },
  { program: 'git', ruleId: 'CMD_GIT', reason: '可能改写历史（需看子命令）' },
  { program: 'curl', ruleId: 'CMD_NET', reason: '网络下载' },
  { program: 'wget', ruleId: 'CMD_NET', reason: '网络下载' },
  { program: 'ssh', ruleId: 'CMD_NET', reason: '远程连接' },
  { program: 'scp', ruleId: 'CMD_NET', reason: '远程拷贝' },
]

function normalize(program: string): string {
  const base = program.replace(/\\/g, '/').split('/').pop() ?? program
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
}

function isRootTarget(target: string): boolean {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/, '')
  return (
    normalized === '' ||
    normalized === '/' ||
    normalized === '~' ||
    normalized === '.' ||
    normalized === '..' ||
    /^[a-zA-Z]:$/.test(normalized) ||
    /^[a-zA-Z]:\/?$/.test(normalized)
  )
}

/** 命令风险分级（sandbox.md §5.2 的数据源；命令一律结构化 argv，不经 shell） */
export function classifyCommand(program: string, args: readonly string[]): CommandRisk {
  const name = normalize(program)
  if (name.length === 0) {
    return { level: 'deny', ruleId: 'CMD_EMPTY', reason: '空命令', network: 'none' }
  }
  if (DENY_PROGRAMS.has(name)) {
    return { level: 'deny', ruleId: 'CMD_DENY_SYSTEM', reason: `禁止的系统级命令：${name}`, network: 'none' }
  }

  // 递归强删根目录/家目录（含 Windows 盘根）
  const flags = args.join(' ').toLowerCase()
  if ((name === 'rm' || name === 'rmdir' || name === 'rd') && /-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r/.test(flags)) {
    const targets = args.filter((arg) => !arg.startsWith('-'))
    if (targets.some((target) => isRootTarget(target))) {
      return { level: 'deny', ruleId: 'CMD_DENY_ROOT_DELETE', reason: '禁止删除根/家目录', network: 'none' }
    }
    return { level: 'high', ruleId: 'CMD_RM', reason: '递归强制删除', network: 'none' }
  }
  if (name === 'remove-item' && /-recurse|-r\b/.test(flags) && /-force|-f\b/.test(flags)) {
    const targets = args.filter((arg) => !arg.startsWith('-'))
    if (targets.some((target) => isRootTarget(target))) {
      return { level: 'deny', ruleId: 'CMD_DENY_ROOT_DELETE', reason: '禁止删除盘根/家目录', network: 'none' }
    }
    return { level: 'high', ruleId: 'CMD_REMOVE_ITEM', reason: '递归强制删除（PowerShell）', network: 'none' }
  }
  if (name === 'dd' && flags.includes('of=/dev/')) {
    return { level: 'deny', ruleId: 'CMD_DENY_DD', reason: '禁止写裸设备', network: 'none' }
  }
  if (name === 'git') {
    const sub = (args[0] ?? '').toLowerCase()
    if (['reset', 'clean', 'rebase', 'filter-branch', 'push'].includes(sub)) {
      return {
        level: 'high',
        ruleId: 'CMD_GIT_REWRITE',
        reason: `git ${sub} 可能改写/覆盖历史`,
        network: sub === 'push' ? 'outbound' : 'none',
      }
    }
    return { level: 'none', ruleId: 'CMD_GIT_READ', reason: 'git 只读子命令', network: 'none' }
  }

  // 内联代码执行：解释器 + 内联开关等于"任意代码"，可绕过命令风险表 → 一律走审批
  const INLINE_CODE_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh', 'node', 'python', 'python3', 'perl', 'ruby'])
  const INLINE_FLAGS = ['-e', '--eval', '-c', '/c', '-command', '--command']
  if (INLINE_CODE_PROGRAMS.has(name) && args.some((arg) => INLINE_FLAGS.includes(arg.toLowerCase()))) {
    return {
      level: 'high',
      ruleId: 'CMD_INLINE_CODE',
      reason: '内联代码执行（可绕过命令风险限制，需用户确认）',
      network: 'none',
    }
  }

  const known = HIGH_RISK_PROGRAMS.find((entry) => entry.program === name)
  if (known !== undefined) {    // npm/pip 之类只有 install/add 才算高危
    if (known.ruleId === 'CMD_INSTALL') {
      const sub = (args[0] ?? '').toLowerCase()
      if (!['install', 'i', 'add', 'ci', 'update', 'upgrade'].includes(sub)) {
        return { level: 'none', ruleId: 'CMD_LOW', reason: '非安装类子命令', network: 'none' }
      }
      return { level: 'high', ruleId: known.ruleId, reason: known.reason, network: 'outbound' }
    }
    return {
      level: 'high',
      ruleId: known.ruleId,
      reason: known.reason,
      network: known.ruleId === 'CMD_NET' ? 'outbound' : 'none',
    }
  }

  const WRITE_PROGRAMS = new Set(['mkdir', 'touch', 'cp', 'copy', 'move', 'mv', 'new-item', 'set-content', 'out-file'])
  if (WRITE_PROGRAMS.has(name)) {
    return { level: 'low', ruleId: 'CMD_WRITE', reason: '工作目录内写入', network: 'none' }
  }
  return { level: 'none', ruleId: 'CMD_READ', reason: '只读命令', network: 'none' }
}

export function createPolicyEngine(): PolicyEngine {
  return {
    decide(input: PolicyInput): PolicyOutcome {
      const { action, projectPolicy, trust } = input

      // ── 1) deny 优先 ───────────────────────────────────────────
      if (action.kind === 'command') {
        const risk = classifyCommand(action.program, action.args)
        if (risk.level === 'deny') {
          return { decision: 'deny', ruleId: risk.ruleId, reason: risk.reason }
        }
        if (risk.network === 'outbound' && projectPolicy.network === 'offline') {
          return {
            decision: 'deny',
            ruleId: 'NET_OFFLINE',
            reason: '项目处于离线模式：禁止联网命令（SANDBOX__NETWORK=offline）',
          }
        }
        if (projectPolicy.highRiskCommands && risk.level === 'high') {
          return { decision: 'approval', ruleId: risk.ruleId, reason: risk.reason }
        }
        return { decision: 'allow', ruleId: risk.ruleId, reason: risk.reason }
      }

      if (action.network !== 'none' && projectPolicy.network === 'offline') {
        return {
          decision: 'deny',
          ruleId: 'NET_OFFLINE',
          reason: '项目处于离线模式：禁止联网动作（SANDBOX__NETWORK=offline）',
        }
      }

      // ── 1.5) 产出物登记：是否需审批由项目 artifactPolicy 决定（workspaces-artifacts §6）──
      if (action.kind === 'submit') {
        const gate = action.artifactType === 'code' ? projectPolicy.codeSubmitApproval : projectPolicy.docSubmitApproval
        if (gate || action.risk === 'high' || action.needsApproval) {
          return {
            decision: 'approval',
            ruleId: action.artifactType === 'code' ? 'SUBMIT_CODE_APPROVAL' : 'SUBMIT_DOC_APPROVAL',
            reason: `产出物登记（${action.artifactType}）需要用户确认`,
          }
        }
        return { decision: 'allow', ruleId: 'SUBMIT_FREE', reason: '登记免审批（artifactPolicy 已关闭审批门）' }
      }

      // ── 2) trust 可以放行"待审批但已记住"的动作（D17-④，默认仅 doc/test）──
      if (trust !== undefined && trust.instanceId === input.actor.instanceId && action.needsApproval) {
        const tag = action.tool.startsWith('doc') ? 'doc' : action.tool.startsWith('test') ? 'test' : 'other'
        if (trust.allows.includes(tag)) {
          return { decision: 'allow', ruleId: 'TRUST_REMEMBERED', reason: `已记住同意（${tag}）` }
        }
      }

      // ── 3) approval ───────────────────────────────────────────
      if (action.risk === 'high' || action.needsApproval) {
        return {
          decision: 'approval',
          ruleId: action.needsApproval ? 'TOOL_NEEDS_APPROVAL' : 'TOOL_HIGH_RISK',
          reason: `工具 ${action.tool} 需要用户审批`,
        }
      }

      return { decision: 'allow', ruleId: 'DEFAULT_ALLOW', reason: '无需审批' }
    },
  }
}
