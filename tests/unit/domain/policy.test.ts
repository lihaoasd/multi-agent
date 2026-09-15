import { describe, expect, it } from 'vitest'
import { classifyCommand, createPolicyEngine } from '../../../src/domain/rules/policy'
import type { PolicyInput } from '../../../src/ports/policy'

const actor = { kind: 'agent' as const, projectId: 'p_1', instanceId: 'dev_1' }
const projectPolicy = {
  highRiskCommands: true,
  docSubmitApproval: true,
  codeSubmitApproval: false,
  network: 'online' as const,
}

describe('domain/rules/policy · 命令风险分级', () => {
  it('deny：系统级命令与根目录删除', () => {
    expect(classifyCommand('format', ['C:']).level).toBe('deny')
    expect(classifyCommand('shutdown', ['-h']).level).toBe('deny')
    expect(classifyCommand('rm', ['-rf', '/']).level).toBe('deny')
    expect(classifyCommand('rm', ['-rf', '~']).level).toBe('deny')
    expect(classifyCommand('Remove-Item', ['-Recurse', '-Force', 'C:\\']).level).toBe('deny')
    expect(classifyCommand('dd', ['if=/dev/zero', 'of=/dev/sda']).level).toBe('deny')
  })

  it('high：递归删除（非根）、装依赖、改写 git 历史、联网命令', () => {
    expect(classifyCommand('rm', ['-rf', 'node_modules']).level).toBe('high')
    expect(classifyCommand('npm', ['install']).level).toBe('high')
    expect(classifyCommand('npm', ['run', 'build']).level).toBe('none')
    expect(classifyCommand('git', ['reset', '--hard']).level).toBe('high')
    expect(classifyCommand('git', ['status']).level).toBe('none')
    expect(classifyCommand('curl', ['https://example.com']).level).toBe('high')
    expect(classifyCommand('taskkill', ['/pid', '1']).level).toBe('high')
  })

  it('high：内联代码执行与解释器拼接（可绕过命令风险表）', () => {
    expect(classifyCommand('node', ['-e', 'require("fs").rmSync("x", {recursive:true})']).level).toBe('high')
    expect(classifyCommand('python', ['-c', 'import shutil']).level).toBe('high')
    expect(classifyCommand('bash', ['-c', 'rm -rf ~']).level).toBe('high')
    expect(classifyCommand('powershell', ['-Command', 'Remove-Item -Recurse -Force C:\\']).level).toBe('high')
    // 运行脚本文件（非内联）不属于此类
    expect(classifyCommand('node', ['scripts/build.mjs']).level).toBe('none')
  })

  it('low/none：工作目录内写入与只读命令', () => {
    expect(classifyCommand('mkdir', ['tmp']).level).toBe('low')
    expect(classifyCommand('node', ['-v']).level).toBe('none')
    expect(classifyCommand('git', ['log']).level).toBe('none')
  })
})

describe('domain/rules/policy · 判定优先级 deny > approval > allow', () => {
  const engine = createPolicyEngine()
  const decide = (input: Partial<PolicyInput> & Pick<PolicyInput, 'action'>): string =>
    engine.decide({ actor, sessionType: 'user', projectPolicy, ...input }).decision

  it('deny 覆盖 approval：高危命令在离线模式下仍是 deny', () => {
    const outcome = engine.decide({
      actor,
      sessionType: 'user',
      action: { kind: 'command', program: 'rm', args: ['-rf', '/'] },
      projectPolicy: { ...projectPolicy, network: 'offline' },
    })
    expect(outcome).toMatchObject({ decision: 'deny', ruleId: 'CMD_DENY_ROOT_DELETE' })
  })

  it('高危命令在开启审批时走 approval，关闭审批时放行', () => {
    expect(decide({ action: { kind: 'command', program: 'rm', args: ['-rf', 'dist'] } })).toBe('approval')
    expect(
      decide({
        action: { kind: 'command', program: 'rm', args: ['-rf', 'dist'] },
        projectPolicy: { ...projectPolicy, highRiskCommands: false },
      }),
    ).toBe('allow')
  })

  it('只读命令直接放行', () => {
    expect(decide({ action: { kind: 'command', program: 'node', args: ['-v'] } })).toBe('allow')
  })

  it('离线模式拒绝联网动作（工具与命令两条路径）', () => {
    const offline = { ...projectPolicy, network: 'offline' as const }
    expect(
      engine.decide({
        actor,
        sessionType: 'user',
        projectPolicy: offline,
        action: { kind: 'command', program: 'curl', args: ['https://example.com'] },
      })).toMatchObject({ decision: 'deny', ruleId: 'NET_OFFLINE' })
    expect(
      engine.decide({
        actor,
        sessionType: 'user',
        projectPolicy: offline,
        action: { kind: 'tool', tool: 'http_fetch', params: {}, risk: 'none', network: 'allowed', needsApproval: false },
      })).toMatchObject({ decision: 'deny', ruleId: 'NET_OFFLINE' })
  })

  it('工具：high 风险或显式 needsApproval → approval；其余 allow', () => {
    expect(
      decide({ action: { kind: 'tool', tool: 'cmd_run', params: {}, risk: 'high', network: 'allowed', needsApproval: false } }),
    ).toBe('approval')
    expect(
      decide({ action: { kind: 'tool', tool: 'artifact_submit', params: {}, risk: 'low', network: 'none', needsApproval: true } }),
    ).toBe('approval')
    expect(
      decide({ action: { kind: 'tool', tool: 'fs_read_file', params: {}, risk: 'none', network: 'none', needsApproval: false } }),
    ).toBe('allow')
  })

  it('信任开关只放行被记住的类别（D17-④）', () => {
    const trusted: PolicyInput = {
      actor,
      sessionType: 'user',
      projectPolicy,
      action: { kind: 'tool', tool: 'doc_submit', params: {}, risk: 'low', network: 'none', needsApproval: true },
      trust: { sessionId: 'u_dev_1', instanceId: 'dev_1', allows: ['doc'] },
    }
    expect(engine.decide(trusted)).toMatchObject({ decision: 'allow', ruleId: 'TRUST_REMEMBERED' })

    const notTrusted: PolicyInput = {
      ...trusted,
      trust: { sessionId: 'u_dev_1', instanceId: 'dev_1', allows: ['test'] },
    }
    expect(engine.decide(notTrusted).decision).toBe('approval')
  })
})
