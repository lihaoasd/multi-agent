import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPathResolver } from '../../../src/infra/sandbox/path-resolver'
import type { PathRoots } from '../../../src/ports/path-resolver'

function setupRoots(): { roots: PathRoots; workdir: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'ah-paths-'))
  const workdir = join(base, 'workdir')
  const runtime = join(base, 'runtime')
  const ro = join(base, 'ro')
  const outside = join(base, 'outside')
  for (const dir of [workdir, runtime, ro, outside]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(workdir, 'index.ts'), 'export const a = 1\n')
  writeFileSync(join(outside, 'secret.txt'), 'top secret\n')
  return { roots: { workdir, runtime, readonly: [ro] }, workdir, outside }
}

describe('infra/sandbox/path-resolver · 边界（规则 2）', () => {
  it('workdir:// 正常解析为绝对路径 + 相对引用', () => {
    const { roots } = setupRoots()
    const resolver = createPathResolver()
    const resolved = resolver.resolve('workdir://index.ts', roots)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.value.relPath).toBe('index.ts')
      expect(resolved.value.absolute.startsWith(roots.workdir)).toBe(true)
    }
  })

  it('缺少 scheme / 绝对路径 / .. 逃逸 一律拒绝（ERR_FORBIDDEN_PATH）', () => {
    const { roots } = setupRoots()
    const resolver = createPathResolver()
    for (const bad of ['index.ts', '/etc/passwd', 'C:/Windows/win.ini', 'workdir://../../outside/secret.txt', 'file:///etc/passwd']) {
      const result = resolver.resolve(bad, roots)
      expect(result.ok, `应拒绝：${bad}`).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('ERR_FORBIDDEN_PATH')
    }
  })

  it('只读根不可写；workdir 允许写（含尚未存在的文件）', () => {
    const { roots } = setupRoots()
    const resolver = createPathResolver()
    expect(resolver.resolveForWrite('ro://x.txt', roots).ok).toBe(false)
    const write = resolver.resolveForWrite('workdir://src/new-file.ts', roots)
    expect(write.ok).toBe(true)
  })

  it('符号链接逃逸被拒绝（真实路径复核）', () => {
    const { roots, outside } = setupRoots()
    const linkPath = join(roots.workdir, 'escape')
    try {
      symlinkSync(outside, linkPath, 'junction')
    } catch {
      // Windows 无权限创建链接：跳过该断言（CI 上 Linux/macOS 会真实执行）
      return
    }
    const resolver = createPathResolver()
    const result = resolver.resolve('workdir://escape/secret.txt', roots)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ERR_FORBIDDEN_PATH')
  })

  it('relativize 反解回虚拟路径；根外返回 null', () => {
    const { roots, outside } = setupRoots()
    const resolver = createPathResolver()
    expect(resolver.relativize(join(roots.workdir, 'src', 'a.ts'), roots)).toBe('workdir://src/a.ts')
    expect(resolver.relativize(join(outside, 'secret.txt'), roots)).toBeNull()
  })

  it('runtime:// 根可用（会话与运行时文件）', () => {
    const { roots } = setupRoots()
    const resolver = createPathResolver()
    const resolved = resolver.resolveForWrite('runtime://artifacts/a.txt', roots)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.value.scheme).toBe('runtime')
  })
})
