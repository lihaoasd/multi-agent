/**
 * 存储端口契约测试（重构 P1，2026-09-14）。
 *
 * 这是 P1 的**验收基础**：迁移 15 个 store 之前，先证明抽象层本身与本项目既有语义一致。
 * 若这些契约被破坏，迁移后既有 `data/` 数据与 257 个用例都会回归。
 */
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createFileStorage } from '../../src/infra/store/file-store.js'
import { StorageFacade } from '../../src/infra/store/project-store.js'
import { ErrorCodes } from '../../src/shared/errors.js'
import { makeTempDir } from '../helpers.js'

let root: string
let storage: ReturnType<typeof createFileStorage>
let facade: StorageFacade

/** 项目运行时目录（= projectsRoot/<pid>）。 */
const projectDir = () => join(root, 'p1')
/** 端口作用域（低层 API）。 */
const loc = (relPath: string) => ({ baseDir: projectDir(), relPath })

beforeEach(async () => {
  root = await makeTempDir('store-')
  storage = createFileStorage(root)
  facade = new StorageFacade(storage, storage.root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('StorageRoot 路径边界', () => {
  it('正常相对路径解析到项目目录内', () => {
    const abs = storage.root.resolve({ projectId: 'p1', relPath: 'sessions/u_dev_1.log.jsonl' })
    expect(abs.replace(/\\/g, '/')).toMatch(/p1\/sessions\/u_dev_1\.log\.jsonl$/)
  })

  it('目录穿越写法被拒（ERR_FORBIDDEN_PATH）', () => {
    expect(() =>
      storage.root.resolve({ projectId: 'p1', relPath: '../other/secret.json' }),
    ).toThrowError(expect.objectContaining({ code: ErrorCodes.FORBIDDEN_PATH }))
  })

  it('绝对路径被拒（不在项目目录内）', () => {
    expect(() =>
      storage.root.resolve({ projectId: 'p1', relPath: 'C:/Windows/system32/x.txt' }),
    ).toThrowError(expect.objectContaining({ code: ErrorCodes.FORBIDDEN_PATH }))
  })
})

describe('FileJsonlStore', () => {
  it('文件不存在 → readAll 返回空数组（缺失 = 空集合，不抛错）', async () => {
    expect(await storage.jsonl.readAll(loc('nothing.jsonl'))).toEqual([])
    expect(await storage.jsonl.readTail(loc('nothing.jsonl'), 5)).toEqual([])
  })

  it('append 后可逐条读回，且自动建目录', async () => {
    await storage.jsonl.append(loc('nested/a.jsonl'), { id: 1 })
    await storage.jsonl.append(loc('nested/a.jsonl'), { id: 2 })
    expect(await storage.jsonl.readAll(loc('nested/a.jsonl'))).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('readTail 取尾部 n 条', async () => {
    for (const id of [1, 2, 3, 4]) await storage.jsonl.append(loc('t.jsonl'), { id })
    expect(await storage.jsonl.readTail(loc('t.jsonl'), 2)).toEqual([{ id: 3 }, { id: 4 }])
  })

  it('坏行跳过：单行损坏不丢整个文件（data-storage §9 容错）', async () => {
    await storage.jsonl.append(loc('bad.jsonl'), { id: 1 })
    await appendFile(join(projectDir(), 'bad.jsonl'), '{ 这不是 JSON\n', 'utf8')
    await storage.jsonl.append(loc('bad.jsonl'), { id: 3 })
    expect(await storage.jsonl.readAll(loc('bad.jsonl'))).toEqual([{ id: 1 }, { id: 3 }])
  })

  it('空行被忽略', async () => {
    await mkdir(projectDir(), { recursive: true })
    await writeFile(join(projectDir(), 'blank.jsonl'), '\n{"a":1}\n\n\n{"a":2}\n', 'utf8')
    expect(await storage.jsonl.readAll(loc('blank.jsonl'))).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('追加不覆盖已有内容（append-only）', async () => {
    await storage.jsonl.append(loc('x.jsonl'), { n: 1 })
    await storage.jsonl.append(loc('x.jsonl'), { n: 2 })
    await storage.jsonl.append(loc('x.jsonl'), { n: 3 })
    const all = (await storage.jsonl.readAll(loc('x.jsonl'))) as Array<{ n: number }>
    expect(all.map((r) => r.n)).toEqual([1, 2, 3])
  })

  describe('mutate（整文件重写的读-改-写）', () => {
    it('按返回值重写整文件，行格式为「每行一条 JSON + 末尾换行」', async () => {
      await storage.jsonl.append(loc('m.jsonl'), { id: 1, v: 'a' })
      await storage.jsonl.append(loc('m.jsonl'), { id: 2, v: 'b' })
      await storage.jsonl.mutate(loc('m.jsonl'), (all) =>
        (all as Array<{ id: number; v: string }>).map((r) => (r.id === 2 ? { ...r, v: 'B' } : r)),
      )
      const raw = await readFile(join(projectDir(), 'm.jsonl'), 'utf8')
      expect(raw).toBe('{"id":1,"v":"a"}\n{"id":2,"v":"B"}\n')
      expect(await storage.jsonl.readAll(loc('m.jsonl'))).toEqual([
        { id: 1, v: 'a' },
        { id: 2, v: 'B' },
      ])
    })

    it('返回 null → 不写文件，返回当前数组', async () => {
      await storage.jsonl.append(loc('k.jsonl'), { id: 1 })
      const before = await readFile(join(projectDir(), 'k.jsonl'), 'utf8')
      const result = await storage.jsonl.mutate(loc('k.jsonl'), () => null)
      expect(result).toEqual([{ id: 1 }])
      expect(await readFile(join(projectDir(), 'k.jsonl'), 'utf8')).toBe(before)
    })

    it('文件不存在时 mutate 以空数组为输入', async () => {
      const result = await storage.jsonl.mutate(loc('new.jsonl'), (all) => [
        ...(all as unknown[]),
        { id: 1 },
      ])
      expect(result).toEqual([{ id: 1 }])
      expect(await storage.jsonl.readAll(loc('new.jsonl'))).toEqual([{ id: 1 }])
    })

    it('并发 mutate 不丢记录（读-改-写持锁）', async () => {
      await Promise.all(
        Array.from({ length: 20 }, (_v, i) =>
          storage.jsonl.mutate(loc('c.jsonl'), (all) => [...(all as unknown[]), { i }]),
        ),
      )
      const all = (await storage.jsonl.readAll(loc('c.jsonl'))) as Array<{ i: number }>
      expect(all).toHaveLength(20)
      expect(all.map((r) => r.i).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_v, i) => i),
      )
    })
  })
})

describe('FileJsonStore', () => {
  it('不存在 → read 返回 null', async () => {
    expect(await storage.json.read(loc('missing.json'))).toBeNull()
  })

  it('write/read 往返一致，且自动建目录', async () => {
    await storage.json.write(loc('deep/dir/meta.json'), { schemaVersion: 1, lastSeq: 7 })
    expect(await storage.json.read(loc('deep/dir/meta.json'))).toEqual({
      schemaVersion: 1,
      lastSeq: 7,
    })
  })

  it('内容损坏 → read 抛 ERR_INTERNAL（结构化文件不能静默当空）', async () => {
    await mkdir(projectDir(), { recursive: true })
    await writeFile(join(projectDir(), 'broken.json'), '{ not json', 'utf8')
    await expect(storage.json.read(loc('broken.json'))).rejects.toMatchObject({
      code: ErrorCodes.INTERNAL,
    })
  })

  it('mutate 读到当前值并写回返回值', async () => {
    await storage.json.write(loc('c.json'), { n: 1 })
    const next = await storage.json.mutate<{ n: number }>(loc('c.json'), (cur) => ({
      n: ((cur as { n: number }).n ?? 0) + 1,
    }))
    expect(next).toEqual({ n: 2 })
    expect(await storage.json.read(loc('c.json'))).toEqual({ n: 2 })
  })

  it('mutate 返回 null → 不写文件（当前值即结果）', async () => {
    await storage.json.write(loc('d.json'), { keep: true })
    const same = await storage.json.mutate(loc('d.json'), () => null)
    expect(same).toEqual({ keep: true })
    expect(await storage.json.read(loc('d.json'))).toEqual({ keep: true })
  })

  it('mutate 并发不丢更新（读-改-写持锁）', async () => {
    await storage.json.write(loc('counter.json'), { n: 0 })
    await Promise.all(
      Array.from({ length: 20 }, () =>
        storage.json.mutate(loc('counter.json'), (cur) => ({
          n: ((cur as { n: number }).n ?? 0) + 1,
        })),
      ),
    )
    expect(await storage.json.read(loc('counter.json'))).toEqual({ n: 20 })
  })
})

describe('FileDirectoryStore', () => {
  it('目录不存在 → 空数组', async () => {
    expect(await storage.dir.list(loc('nope'))).toEqual([])
  })

  it('列出目录内文件名', async () => {
    await storage.jsonl.append(loc('sessions/a.meta.json'), {})
    await storage.jsonl.append(loc('sessions/b.meta.json'), {})
    const names = await storage.dir.list(loc('sessions'))
    expect(names.sort()).toEqual(['a.meta.json', 'b.meta.json'])
  })
})

describe('ProjectStore 门面（application 层的唯一 IO 边界）', () => {
  it('forProject：按 projectId 定位项目目录，读写往返一致', async () => {
    const ps = facade.forProject('p1')
    await ps.append('p1', 'memories/global.jsonl', { id: 'm1' })
    expect(await ps.readAll('p1', 'memories/global.jsonl')).toEqual([{ id: 'm1' }])
    expect(ps.abs('p1', 'memories')).toMatch(/p1[\\/]memories$/)
  })

  it('forProjectsRoot：作用域 = <root>/<调用时的 projectId>（迁移前 store 语义）', async () => {
    const ps = facade.forProjectsRoot(root)
    await ps.append('pA', 'x.jsonl', { id: 1 })
    await ps.append('pB', 'x.jsonl', { id: 2 })
    // 同一门面实例按调用参数落到不同项目目录
    expect(await ps.readAll('pA', 'x.jsonl')).toEqual([{ id: 1 }])
    expect(await ps.readAll('pB', 'x.jsonl')).toEqual([{ id: 2 }])
    expect(ps.abs('pA', 'x.jsonl')).toBe(join(root, 'pA', 'x.jsonl'))
  })

  it('forProjectAbs：既有测试的绝对目录寻址等价可用', async () => {
    const ps = facade.forProjectAbs(projectDir())
    await ps.writeJson('p1', 'runtime.state.json', { schemaVersion: 1, occupancy: {} })
    expect(await ps.readJson('p1', 'runtime.state.json')).toEqual({
      schemaVersion: 1,
      occupancy: {},
    })
    expect(ps.abs('p1', 'runtime.state.json')).toBe(join(projectDir(), 'runtime.state.json'))
  })

  it('forProjectAbs：越界相对路径仍被拒', async () => {
    const ps = facade.forProjectAbs(projectDir())
    await expect(ps.readAll('p1', '../outside.jsonl')).rejects.toMatchObject({
      code: ErrorCodes.FORBIDDEN_PATH,
    })
  })

  it('mutateJson：读-改-写 JSON', async () => {
    const ps = facade.forProject('p1')
    await ps.writeJson('p1', 'counter.json', { n: 0 })
    await ps.mutateJson<{ n: number }>('p1', 'counter.json', (cur) => ({ n: (cur?.n ?? 0) + 5 }))
    expect(await ps.readJson('p1', 'counter.json')).toEqual({ n: 5 })
  })

  it('remove：删除文件后读回为空集合', async () => {
    const ps = facade.forProject('p1')
    await ps.append('p1', 'trail.jsonl', { id: 1 })
    await ps.remove('p1', 'trail.jsonl')
    expect(await ps.readAll('p1', 'trail.jsonl')).toEqual([])
  })
})
