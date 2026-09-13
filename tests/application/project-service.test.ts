import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProjectService } from '../../src/application/project/project-service.js'
import { ErrorCodes } from '../../src/shared/errors.js'
import { makeStoreForProjectsRoot, makeTempDir } from '../helpers.js'

let base: string
let workdir: string
let svc: ProjectService

const defaults = {
  artifactPolicy: { codeSubmitApproval: false, docSubmitApproval: true },
  approvalPolicy: { highRiskCommands: true },
}

beforeEach(async () => {
  base = await makeTempDir('proj-')
  workdir = join(base, 'workdir')
  await mkdir(workdir)
  svc = new ProjectService(makeStoreForProjectsRoot(join(base, 'projects')), defaults)
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('ProjectService', () => {
  it('create 生成运行时文件夹与 project.json（schema v1）', async () => {
    const p = await svc.create({ name: 'todo-app', description: 'demo', workdir })
    expect(p.schemaVersion).toBe(1)
    expect(p.id).toMatch(/^p_/)
    expect(p.workdirKind).toBe('empty')
    expect(p.team).toEqual([])
    expect(p.artifactPolicy.docSubmitApproval).toBe(true)

    const file = join(base, 'projects', p.id, 'project.json')
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    expect(onDisk.id).toBe(p.id)
  })

  it('workdirKind 检测：含文件视为 existing-repo', async () => {
    await writeFile(join(workdir, 'x.txt'), 'x')
    const p = await svc.create({ name: 'repo', workdir })
    expect(p.workdirKind).toBe('existing-repo')
  })

  it('create 校验：空名称拒绝；workdir 不存在拒绝', async () => {
    await expect(svc.create({ name: '  ', workdir })).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
    })
    await expect(svc.create({ name: 'x', workdir: join(base, 'not-exist') })).rejects.toMatchObject(
      { code: ErrorCodes.VALIDATION },
    )
  })

  it('list 按创建时间倒序；get 返回详情', async () => {
    const a = await svc.create({ name: 'a', workdir })
    await new Promise((r) => setTimeout(r, 5))
    const b = await svc.create({ name: 'b', workdir })
    const list = await svc.list()
    expect(list.map((p) => p.id)).toEqual([b.id, a.id])
    expect((await svc.get(a.id)).name).toBe('a')
  })

  it('get 不存在抛 ERR_NOT_FOUND', async () => {
    await expect(svc.get('p_nope')).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND })
  })

  it('patch 更新名称/描述并刷新 updatedAt', async () => {
    const p = await svc.create({ name: 'a', workdir })
    await new Promise((r) => setTimeout(r, 5))
    const up = await svc.patch(p.id, { name: 'a2', description: 'd' })
    expect(up.name).toBe('a2')
    expect(up.description).toBe('d')
    expect(up.updatedAt >= p.updatedAt).toBe(true)
  })

  it('patch 空名称拒绝且不改文件', async () => {
    const p = await svc.create({ name: 'a', workdir })
    await expect(svc.patch(p.id, { name: ' ' })).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
    })
    expect((await svc.get(p.id)).name).toBe('a')
  })

  it('remove 删除运行时文件夹且不动工作目录', async () => {
    const p = await svc.create({ name: 'a', workdir })
    const workdirFile = join(workdir, 'keep.txt')
    await writeFile(workdirFile, 'keep')
    await svc.remove(p.id)
    await expect(svc.get(p.id)).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND })
    // workdir 与其中文件保留
    await expect(access(workdirFile)).resolves.toBeUndefined()
  })

  it('remove 不存在的项目抛 ERR_NOT_FOUND', async () => {
    await expect(svc.remove('p_nope')).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND })
  })
})
