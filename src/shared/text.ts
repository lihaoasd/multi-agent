/**
 * 文本分词（纯函数，零依赖）：中文 2-gram + ASCII 整词（memory.md §5、data-storage.md §10）。
 * 标点/空白/换行即词元边界；索引侧与查询侧共用本模块，保证可命中。
 */

/** 汉字（含扩展 A 与兼容区）判定 */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
/** 参与整词索引的字符（字母/数字，含部分全角经归一化后落在此区间） */
const WORD_CHAR = /[0-9a-z_]/

function isCjk(char: string): boolean {
  return CJK_CHAR.test(char)
}

function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char)
}

/** 归一化：大小写、全角 ASCII、连续空白（检索比对前统一走这里） */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\r\n?/g, '\n')
}

/**
 * 切词元：
 * - 连续 ASCII 字母/数字 → 整词（长度 ≥2 才索引，单字符噪声太大）；
 * - 连续汉字 → 2-gram（长度 1 时取该字）；
 * - 其余（标点、空白、换行、emoji）作为边界丢弃。
 */
export function tokenize(text: string): readonly string[] {
  const normalized = normalizeForSearch(text)
  const tokens = new Set<string>()
  let buffer = ''
  let mode: 'word' | 'cjk' | null = null

  const flush = (): void => {
    if (buffer.length === 0) return
    if (mode === 'word') {
      if (buffer.length >= 2) tokens.add(buffer)
    } else if (mode === 'cjk') {
      if (buffer.length === 1) tokens.add(buffer)
      else for (let index = 0; index + 1 < buffer.length; index += 1) tokens.add(buffer.slice(index, index + 2))
    }
    buffer = ''
  }

  for (const char of normalized) {
    if (isCjk(char)) {
      if (mode !== 'cjk') {
        flush()
        mode = 'cjk'
      }
      buffer += char
    } else if (isWordChar(char)) {
      if (mode !== 'word') {
        flush()
        mode = 'word'
      }
      buffer += char
    } else {
      flush()
      mode = null
    }
  }
  flush()
  return [...tokens]
}

/** 去重后的汉字集合：查询词元全不命中时的字符回退（memory.md §5"字符回退"） */
export function cjkChars(text: string): readonly string[] {
  const chars = new Set<string>()
  for (const char of normalizeForSearch(text)) {
    if (isCjk(char)) chars.add(char)
  }
  return [...chars]
}

/**
 * 在文本中定位查询词元的出现区间（前端高亮用；含 2-gram 的重叠区间合并）。
 * 返回按起点升序、互不重叠的 `[start, end)` 区间。
 */
export function findSpans(text: string, tokens: readonly string[]): readonly (readonly [number, number])[] {
  const haystack = normalizeForSearch(text)
  const spans: Array<[number, number]> = []
  for (const token of tokens) {
    if (token.length === 0) continue
    let from = 0
    for (;;) {
      const at = haystack.indexOf(token, from)
      if (at < 0) break
      spans.push([at, at + token.length])
      from = at + 1
    }
  }
  if (spans.length === 0) return []
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: Array<[number, number]> = [spans[0] as [number, number]]
  for (const span of spans.slice(1)) {
    const last = merged[merged.length - 1] as [number, number]
    if (span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push(span)
  }
  return merged
}

/** 片段截取：以首个命中为中心取窗口，超长时两侧省略（检索结果回注与 UI 预览共用） */
export function snippetAround(text: string, tokens: readonly string[], maxChars = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  const haystack = normalizeForSearch(flat)
  let at = -1
  for (const token of tokens) {
    const found = haystack.indexOf(token)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  if (at < 0) return `${flat.slice(0, maxChars)}…`
  const start = Math.max(0, at - Math.floor(maxChars / 3))
  const end = Math.min(flat.length, start + maxChars)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
