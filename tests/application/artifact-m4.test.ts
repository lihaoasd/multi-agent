import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ArtifactService } from '../../src/application/artifact/artifact-service.js'
import { ApprovalService } from '../../src/application/approval/approval-service.js'
import { LocalFileOps } from '../../src/infra/store/local-file-ops.js'
import type { SessionLogEvent } from '../../src/shared/types/session.js'
import { makeStoreForProjectsRoot, makeTempDir } from '../helpers.js'

let base: string
let workdir: string
let runtime: string
let wsDir: string
let artifacts: ArtifactService
let approvals: ApprovalService

const actor = 'pm_1'
const pid = 'p_test'

beforeEach(async () => {
  base = await makeTempDir('m4-')
  workdir = join(base, 'workdir')
  runtime = join(base, 'projects', pid)
  wsDir = join(runtime, 'workspaces', actor)
  await mkdir(join(wsDir, 'drafts'), { recursive: true })
  await mkdir(join(workdir, 'docs'), { recursive: true })
  // project.json（ArtifactService ctxOf 读取）
  await mkdir(runtime, { recursive: true })
  await writeFile(
    join(runtime, 'project.json'),
    JSON.stringify(
      { id: pid, workdir, team: [], artifactPolicy: { docSubmitApproval: true } },
      null,
      2,
    ),
  )

  const fakeLog = async (
    _p: string,
    sid: string,
    evt: Omit<SessionLogEvent, 'seq' | 'ts' | 'sessionId'>,
  ): Promise<SessionLogEvent> =>
    ({ ...evt, seq: 1, ts: new Date().toISOString(), sessionId: sid }) as SessionLogEvent
  approvals = new ApprovalService(makeStoreForProjectsRoot(join(base, 'projects')), fakeLog)
  artifacts = new ArtifactService(
    makeStoreForProjectsRoot(join(base, 'projects')),
    new LocalFileOps(),
    approvals,
    fakeLog,
  )
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('ArtifactService（静态产物提交制）', () => {
  it('无审批门：提交 → workdir 出现文件 + 快照 + manifest(approved,v1)', async () => {
    await writeFile(join(wsDir, 'drafts', 'prd-v1.md'), '# PRD v1\n正文…')
    const { record } = await artifacts.submit({
      projectId: pid,
      actor,
      sessionId: `u_${actor}`,
      type: 'doc',
      title: 'PRD v1',
      files: [{ relPath: 'docs/prd.md', fromWsRel: 'ws://drafts/prd-v1.md' }],
      needsApproval: false,
    })
    expect(record.state).toBe('approved')
    expect(record.version).toBe(1)
    expect(record.files).toHaveLength(1)
    expect(record.files[0]!.hash).toMatch(/^[0-9a-f]{64}$/)

    // workdir 出现且内容一致
    const dest = join(workdir, 'docs', 'prd.md')
    await expect(access(dest)).resolves.toBeUndefined()
    expect(await readFile(dest, 'utf8')).toContain('# PRD v1')
    // 快照在 versionDir
    const snap = join(base, 'projects', pid, record.versionDir, 'docs', 'prd.md')
    expect(await readFile(snap, 'utf8')).toContain('# PRD v1')
  })

  it('同 actor+type 连续提交 → 版本递增 v2', async () => {
    await writeFile(join(wsDir, 'drafts', 'prd-v1.md'), 'v1')
    await artifacts.submit({
      projectId: pid,
      actor,
      type: 'doc',
      title: 'PRD v1',
      files: [{ relPath: 'docs/prd.md', fromWsRel: 'ws://drafts/prd-v1.md' }],
      needsApproval: false,
    })
    await writeFile(join(wsDir, 'drafts', 'prd-v2.md'), 'v2 content longer')
    const { record } = await artifacts.submit({
      projectId: pid,
      actor,
      type: 'doc',
      title: 'PRD v2',
      files: [{ relPath: 'docs/prd.md', fromWsRel: 'ws://drafts/prd-v2.md' }],
      needsApproval: false,
    })
    expect(record.version).toBe(2)
    expect(await readFile(join(workdir, 'docs', 'prd.md'), 'utf8')).toBe('v2 content longer')
  })

  it('doc 门：needsApproval → submitted+审批；批准 finalize 后写入', async () => {
    await writeFile(join(wsDir, 'drafts', 'req.md'), '# 需求定稿')
    const { record, approvalId } = await artifacts.submit({
      projectId: pid,
      actor,
      sessionId: `u_${actor}`,
      type: 'doc',
      title: '需求',
      files: [{ relPath: 'docs/req.md', fromWsRel: 'ws://drafts/req.md' }],
      needsApproval: true,
    })
    expect(record.state).toBe('submitted')
    expect(approvalId).toBeTruthy()
    // 未批准前不写入
    await expect(access(join(workdir, 'docs', 'req.md'))).rejects.toThrow()

    // 批准 → finalize 写入 approved
    const approval = await approvals.get(pid, approvalId!)
    expect(approval.detail).toContain('preview')
    expect(approval.detail).toContain('# 需求定稿') // 只读预览
    await approvals.decide(pid, approvalId!, 'approved', '同意')
    const finalized = await artifacts.finalizeApproved(pid, approvalId!)
    expect(finalized!.state).toBe('approved')
    expect(await readFile(join(workdir, 'docs', 'req.md'), 'utf8')).toBe('# 需求定稿')
  })

  it('doc 门拒绝 → finalize 抛 CONFLICT 且不写入', async () => {
    await writeFile(join(wsDir, 'drafts', 'r.md'), 'x')
    const { approvalId } = await artifacts.submit({
      projectId: pid,
      actor,
      type: 'doc',
      title: 'x',
      files: [{ relPath: 'docs/r.md', fromWsRel: 'ws://drafts/r.md' }],
      needsApproval: true,
    })
    await approvals.decide(pid, approvalId!, 'rejected')
    await expect(artifacts.finalizeApproved(pid, approvalId!)).rejects.toThrow()
    await expect(access(join(workdir, 'docs', 'r.md'))).rejects.toThrow()
  })

  it('回退：v2 → rollback → workdir 恢复 v1 内容，manifest reverted', async () => {
    await writeFile(join(wsDir, 'drafts', 'a1.md'), '版本一内容 ABC')
    const v1 = await artifacts.submit({
      projectId: pid,
      actor,
      type: 'doc',
      title: 'doc',
      files: [{ relPath: 'docs/a.md', fromWsRel: 'ws://drafts/a1.md' }],
      needsApproval: false,
    })
    await writeFile(join(wsDir, 'drafts', 'a2.md'), '版本二内容 XYZ')
    await artifacts.submit({
      projectId: pid,
      actor,
      type: 'doc',
      title: 'doc',
      files: [{ relPath: 'docs/a.md', fromWsRel: 'ws://drafts/a2.md' }],
      needsApproval: false,
    })
    expect(await readFile(join(workdir, 'docs', 'a.md'), 'utf8')).toBe('版本二内容 XYZ')

    const rolled = await artifacts.rollback(pid, v1.record.id)
    expect(rolled.state).toBe('reverted')
    expect(await readFile(join(workdir, 'docs', 'a.md'), 'utf8')).toBe('版本一内容 ABC')

    const list = await artifacts.list(pid)
    expect(list).toHaveLength(2)
  })

  it('源文件缺失/非法类型/空清单 → 校验错误', async () => {
    await expect(
      artifacts.submit({
        projectId: pid,
        actor,
        type: 'doc',
        title: 'x',
        files: [{ relPath: 'docs/x.md', fromWsRel: 'ws://drafts/nope.md' }],
        needsApproval: false,
      }),
    ).rejects.toThrow()
    await expect(
      artifacts.submit({
        projectId: pid,
        actor,
        type: 'zip' as never,
        title: 'x',
        files: [],
        needsApproval: false,
      }),
    ).rejects.toThrow()
  })
})
