/**
 * 轻量 Markdown 渲染（无依赖、无构建；先转义再渲染，防 XSS）。
 * 支持：标题、段落、围栏代码、行内代码、粗体/斜体/删除线、链接（仅 http/https/mailto）、
 * 有序/无序列表（含续行）、引用、分割线、GFM 风格管道表格。
 * 仅用于助手回复的展示；思考块与用户消息保持纯文本。
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const CODE_TOKEN = '\u0000'

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/** 仅放行安全协议，其余（如 javascript:）按纯文本处理。 */
function safeUrl(url) {
  const u = String(url).trim()
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null
}

/** 行内标记（输入必须是已转义文本）。 */
function inline(src) {
  const codes = []
  let out = String(src).replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code)
    return `${CODE_TOKEN}${codes.length - 1}${CODE_TOKEN}`
  })
  // 图片降级为链接（不加载远程图片）
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const u = safeUrl(url)
    return u ? `[${alt}](${u})` : m
  })
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const u = safeUrl(url)
    return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${text}</a>` : m
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return out.replace(
    new RegExp(`${CODE_TOKEN}(\\d+)${CODE_TOKEN}`, 'g'),
    (_m, i) => `<code>${codes[Number(i)] ?? ''}</code>`,
  )
}

function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

function isTableSeparator(line) {
  return /^[\s|:-]+$/.test(line) && line.includes('-')
}

/** Markdown → HTML（安全转义后的受控子集）。 */
export function renderMarkdown(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const out = []
  let para = []
  let i = 0

  const flushPara = () => {
    if (!para.length) return
    out.push(`<p>${inline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br>')}</p>`)
    para = []
  }

  while (i < lines.length) {
    const line = lines[i]

    const fence = /^\s*```(\S*)\s*$/.exec(line)
    if (fence) {
      flushPara()
      const lang = fence[1] ?? ''
      const buf = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过结束围栏
      out.push(
        `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(
          buf.join('\n'),
        )}</code></pre>`,
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushPara()
      const level = heading[1].length
      out.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`)
      i++
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara()
      out.push('<hr>')
      i++
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara()
      const header = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]))
        i++
      }
      const head = header.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('')
      const body = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`)
        .join('')
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`)
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara()
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push(
        `<blockquote>${inline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`,
      )
      continue
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flushPara()
      const ordered = /\d/.test(item[2])
      const items = []
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (m) {
          items.push(escapeHtml(m[3]))
          i++
          continue
        }
        // 缩进续行并入上一项
        if (items.length && /^\s+\S/.test(lines[i])) {
          items[items.length - 1] += `\n${escapeHtml(lines[i].trim())}`
          i++
          continue
        }
        break
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(
        `<${tag}>${items
          .map((t) => `<li>${inline(t).replace(/\n/g, '<br>')}</li>`)
          .join('')}</${tag}>`,
      )
      continue
    }

    if (line.trim() === '') {
      flushPara()
      i++
      continue
    }

    para.push(line)
    i++
  }

  flushPara()
  return out.join('\n')
}
