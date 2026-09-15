/**
 * 行级 diff（纯函数，零依赖）：为 `workdir_edit` 的变更审计、产出物版本补丁与 diffSummary 服务。
 * 采用经典 LCS 动态规划；文件被裁剪到行数上限以内（超出部分不计入统计，避免内存爆掉）。
 */

const MAX_LINES = 4_000

export interface DiffLine {
  readonly kind: 'context' | 'add' | 'del'
  readonly text: string
}

export interface DiffResult {
  readonly lines: readonly DiffLine[]
  readonly add: number
  readonly del: number
}

function splitLines(text: string | null): readonly string[] {
  if (text === null || text.length === 0) return []
  const lines = text.split(/\r?\n/)
  // 末尾换行会切出一个空串，不计入行集合
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(0, MAX_LINES)
}

export function diffLines(before: string | null, after: string | null): DiffResult {
  const left = splitLines(before)
  const right = splitLines(after)

  // LCS 表
  const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const row = table[i] as number[]
      const next = table[i + 1] as number[]
      row[j] = left[i] === right[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number)
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  let add = 0
  let del = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push({ kind: 'context', text: left[i] as string })
      i += 1
      j += 1
      continue
    }
    const down = (table[i + 1] as number[])[j] as number
    const right_ = (table[i] as number[])[j + 1] as number
    if (down >= right_) {
      lines.push({ kind: 'del', text: left[i] as string })
      del += 1
      i += 1
    } else {
      lines.push({ kind: 'add', text: right[j] as string })
      add += 1
      j += 1
    }
  }
  while (i < left.length) {
    lines.push({ kind: 'del', text: left[i] as string })
    del += 1
    i += 1
  }
  while (j < right.length) {
    lines.push({ kind: 'add', text: right[j] as string })
    add += 1
    j += 1
  }
  return { lines, add, del }
}

/** 变更统计（manifest 的 `diffSummary`） */
export function diffSummary(before: string | null, after: string | null): { add: number; del: number } {
  const result = diffLines(before, after)
  return { add: result.add, del: result.del }
}

/** 统一 diff 文本（多个文件时按 `--- a/<relPath>` / `+++ b/<relPath>` 分段；存为 `diff.patch` 供审计） */
export function unifiedDiff(input: {
  readonly relPath: string
  readonly before: string | null
  readonly after: string | null
}): string {
  const { lines } = diffLines(input.before, input.after)
  const header = [
    `--- ${input.before === null ? '/dev/null' : `a/${input.relPath}`}`,
    `+++ ${input.after === null ? '/dev/null' : `b/${input.relPath}`}`,
  ]
  const body = lines.map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)
  return [...header, ...body].join('\n')
}
