/**
 * 特征化测试 · 命令风险判定 PolicyEngine（重构 P0-4，2026-09-14）。
 *
 * 目的：锁定 `assessCommand` 现状的 **decision + ruleId** 映射（reason 文案不锁，允许措辞演进）。
 * P2 会把这块纯逻辑从 `domain/rules/command-policy.ts` 保留在原地（它已经在 domain），
 * 但会被 `application` 侧改为经 ports 调用；本测试保证判定矩阵不漂移。
 *
 * 判定优先级：deny > approval > allow（`docs/design/sandbox.md` §5、tools.md §2）
 */
import { describe, expect, it } from 'vitest'

import { assessCommand } from '../../src/domain/rules/command-policy.js'

/** 断言判定结果（只比对 decision 与 ruleId，reason 属文案不锁）。 */
function verdict(program: string, args: string[] = [], offline = false) {
  const v = assessCommand({ program, args, offline })
  return { decision: v.decision, ruleId: v.ruleId }
}

describe('assessCommand（命令风险判定）', () => {
  describe('deny（禁止执行）', () => {
    it('curl 管道执行脚本 → CURL_PIPE_SH', () => {
      expect(verdict('curl', ['https://x.sh', '|', 'sh'])).toEqual({
        decision: 'deny',
        ruleId: 'CURL_PIPE_SH',
      })
    })

    it('离线模式下联网命令 → NET_OFFLINE（deny）', () => {
      // curl 本身属联网类且不命中前面的高危规则 → offline 判定生效
      expect(verdict('curl', ['https://x'], true)).toEqual({
        decision: 'deny',
        ruleId: 'NET_OFFLINE',
      })
      // wget 同类
      expect(verdict('wget', ['https://x'], true)).toEqual({
        decision: 'deny',
        ruleId: 'NET_OFFLINE',
      })
    })

    it('已知怪癖：离线判定对 git push 不可达（GIT_PUSH 在其之前 return）', () => {
      // 现状：NET_OFFLINE 检查位于 GIT_PUSH/NPM_PUBLISH 等规则之后，
      // 因此 `git push` 即使 offline=true 也先命中 GIT_PUSH（approval）。
      // 特征化测试如实锁定现状；是否调整属行为变更，另开方案，不在本次纯重构内。
      expect(verdict('git', ['push'], true)).toEqual({
        decision: 'approval',
        ruleId: 'GIT_PUSH',
      })
    })
  })

  describe('approval（需用户确认）', () => {
    it('系统级操作 sudo / reg / sc → SYSTEM_LEVEL', () => {
      for (const p of ['sudo', 'reg', 'sc']) {
        expect(verdict(p, ['x'])).toEqual({ decision: 'approval', ruleId: 'SYSTEM_LEVEL' })
      }
    })

    it('递归强删 rm -rf → RM_RF', () => {
      expect(verdict('rm', ['-rf', 'dist'])).toEqual({ decision: 'approval', ruleId: 'RM_RF' })
      expect(verdict('rm', ['-fr', 'dist'])).toEqual({ decision: 'approval', ruleId: 'RM_RF' })
    })

    it('普通删除 rm <file> → RM_FILE', () => {
      expect(verdict('rm', ['a.txt'])).toEqual({ decision: 'approval', ruleId: 'RM_FILE' })
    })

    it('git push → GIT_PUSH；npm publish → NPM_PUBLISH；npm uninstall → NPM_UNINSTALL', () => {
      expect(verdict('git', ['push', 'origin', 'main'])).toEqual({
        decision: 'approval',
        ruleId: 'GIT_PUSH',
      })
      expect(verdict('npm', ['publish'])).toEqual({ decision: 'approval', ruleId: 'NPM_PUBLISH' })
      expect(verdict('npm', ['uninstall', 'x'])).toEqual({
        decision: 'approval',
        ruleId: 'NPM_UNINSTALL',
      })
      expect(verdict('npm', ['remove', 'x'])).toEqual({
        decision: 'approval',
        ruleId: 'NPM_UNINSTALL',
      })
    })

    it('未知 git 子命令 → GIT_OTHER', () => {
      expect(verdict('git', ['rebase'])).toEqual({ decision: 'approval', ruleId: 'GIT_OTHER' })
    })

    it('自由 shell（powershell/pwsh/cmd）→ SHELL_RAW', () => {
      for (const p of ['powershell', 'pwsh', 'cmd']) {
        expect(verdict(p, ['-c', 'x'])).toEqual({ decision: 'approval', ruleId: 'SHELL_RAW' })
      }
    })

    it('临时工具执行 tsx / npx → NPX_TOOL', () => {
      expect(verdict('tsx', ['x.ts'])).toEqual({ decision: 'approval', ruleId: 'NPX_TOOL' })
      expect(verdict('npx', ['create-x'])).toEqual({ decision: 'approval', ruleId: 'NPX_TOOL' })
    })

    it('未知程序默认 approval → UNKNOWN_PROGRAM（宁可多问一次）', () => {
      expect(verdict('some-unknown-bin', ['x'])).toEqual({
        decision: 'approval',
        ruleId: 'UNKNOWN_PROGRAM',
      })
    })

    it('包管理器非白名单子命令 → PKGMGR_OTHER', () => {
      expect(verdict('npm', ['link'])).toEqual({ decision: 'approval', ruleId: 'PKGMGR_OTHER' })
      expect(verdict('yarn', ['why'])).toEqual({ decision: 'approval', ruleId: 'PKGMGR_OTHER' })
    })
  })

  describe('allow（直接执行）', () => {
    it('只读/查询类 → READ_CMD', () => {
      for (const p of ['ls', 'dir', 'cat', 'type', 'pwd', 'find', 'grep', 'where', 'which', 'echo']) {
        expect(verdict(p, ['x'])).toEqual({ decision: 'allow', ruleId: 'READ_CMD' })
      }
    })

    it('构建/测试类 → BUILD_TEST', () => {
      for (const p of ['tsc', 'vitest', 'jest', 'eslint', 'prettier', 'webpack', 'vite']) {
        expect(verdict(p, ['--version'])).toEqual({ decision: 'allow', ruleId: 'BUILD_TEST' })
      }
    })

    it('git 只读子命令 → GIT_READ；clone/pull → GIT_FETCH', () => {
      for (const sub of ['status', 'log', 'diff', 'branch', 'fetch', 'show', 'remote', 'config']) {
        expect(verdict('git', [sub])).toEqual({ decision: 'allow', ruleId: 'GIT_READ' })
      }
      expect(verdict('git', ['clone', 'x'])).toEqual({ decision: 'allow', ruleId: 'GIT_FETCH' })
      expect(verdict('git', ['pull'])).toEqual({ decision: 'allow', ruleId: 'GIT_FETCH' })
    })

    it('node 运行脚本 → NODE_SCRIPT；node -v → NODE_VER', () => {
      expect(verdict('node', ['app.js'])).toEqual({ decision: 'allow', ruleId: 'NODE_SCRIPT' })
      expect(verdict('node', ['--version'])).toEqual({ decision: 'allow', ruleId: 'NODE_VER' })
      expect(verdict('node', ['-v'])).toEqual({ decision: 'allow', ruleId: 'NODE_VER' })
    })

    it('包管理器白名单子命令 → PKGMGR', () => {
      for (const sub of ['install', 'ci', 'run', 'test', 'build', 'add', 'exec', 'create']) {
        expect(verdict('npm', [sub])).toEqual({ decision: 'allow', ruleId: 'PKGMGR' })
      }
    })

    it('python 运行脚本 → PYTHON_SCRIPT', () => {
      expect(verdict('python', ['x.py'])).toEqual({ decision: 'allow', ruleId: 'PYTHON_SCRIPT' })
    })
  })

  describe('程序名归一化（basename + 去扩展名 + 小写）', () => {
    it('带路径与扩展名 → 归一化后命中同一条规则', () => {
      expect(verdict('C:\\Windows\\System32\\reg.exe', ['add'])).toEqual({
        decision: 'approval',
        ruleId: 'SYSTEM_LEVEL',
      })
      expect(verdict('/usr/bin/rm', ['-rf', 'x'])).toEqual({
        decision: 'approval',
        ruleId: 'RM_RF',
      })
      expect(verdict('C:/tools/npm.cmd', ['install'])).toEqual({
        decision: 'allow',
        ruleId: 'PKGMGR',
      })
    })

    it('大小写不敏感', () => {
      expect(verdict('GIT', ['STATUS'])).toEqual({ decision: 'allow', ruleId: 'GIT_READ' })
      expect(verdict('SUDO', ['x'])).toEqual({ decision: 'approval', ruleId: 'SYSTEM_LEVEL' })
    })

    it('无参数程序：rm 无参数不触发删除审批（走未知/其他规则）', () => {
      // rm 无参数：RM_RF 需 -rf/-fr 或首参 rm；RM_FILE 需 a.length>0 → 都不命中
      const v = assessCommand({ program: 'rm', args: [] })
      expect(v.decision).toBe('approval')
      expect(v.ruleId).toBe('UNKNOWN_PROGRAM')
    })
  })
})
