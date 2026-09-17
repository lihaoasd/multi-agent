import type { CSSProperties, ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 消息 Markdown 渲染（S23 起；**S27 改为使用成熟框架**）。
 *
 * 框架：`react-markdown` + `remark-gfm`（GFM：表格 / 删除线 / 任务列表 / 自动链接 / 嵌套列表）。
 * - **安全**：react-markdown **默认不注入 HTML**（未启用 `rehype-raw`，尖括号按文本渲染），
 *   链接走其内置的 `defaultUrlTransform`（放行 http(s)/mailto/tel 与相对地址，挡掉 `javascript:`）；
 * - 这里只用 `components` 覆写样式（表格加边框与横向滚动、代码块等宽、链接新窗口打开），
 *   不改变解析行为；未覆盖的元素用框架默认渲染。
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

const tableCell = (align: unknown): CSSProperties => ({
  border: '1px solid rgba(0,0,0,0.12)',
  padding: '4px 8px',
  textAlign: align === 'center' ? 'center' : align === 'right' ? 'right' : 'left',
  verticalAlign: 'top',
})

const components: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  p: ({ children }) => <p style={{ margin: 0 }}>{children}</p>,
  h1: ({ children }) => <div style={{ fontWeight: 600, fontSize: 16 }}>{children}</div>,
  h2: ({ children }) => <div style={{ fontWeight: 600, fontSize: 15 }}>{children}</div>,
  h3: ({ children }) => <div style={{ fontWeight: 600, fontSize: 14 }}>{children}</div>,
  h4: ({ children }) => <div style={{ fontWeight: 600, fontSize: 13 }}>{children}</div>,
  h5: ({ children }) => <div style={{ fontWeight: 600, fontSize: 12 }}>{children}</div>,
  h6: ({ children }) => <div style={{ fontWeight: 600, fontSize: 12 }}>{children}</div>,
  ul: ({ children }) => <ul style={{ margin: 0, paddingLeft: 20 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: 0, paddingLeft: 20 }}>{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote
      style={{ margin: 0, paddingLeft: 8, borderLeft: '3px solid rgba(0,0,0,0.15)', color: 'rgba(0,0,0,0.65)' }}
    >
      {children}
    </blockquote>
  ),
  hr: () => <hr style={{ margin: '2px 0', border: 'none', borderTop: '1px solid rgba(0,0,0,0.12)' }} />,
  pre: ({ children }) => (
    <pre
      style={{
        margin: 0,
        padding: '6px 8px',
        background: 'rgba(0,0,0,0.04)',
        border: '1px solid rgba(0,0,0,0.08)',
        borderRadius: 6,
        overflowX: 'auto',
        fontFamily: MONO,
        fontSize: 12,
      }}
    >
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    // 围栏代码块（在 pre 内、带 language-* 类）不加行内底色，避免双层背景
    const isBlock = typeof className === 'string' && className.includes('language-')
    if (isBlock) return <code className={className}>{children}</code>
    return (
      <code style={{ background: 'rgba(0,0,0,0.06)', borderRadius: 4, padding: '0 4px', fontFamily: MONO }}>
        {children}
      </code>
    )
  },
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 240 }}>{children}</table>
    </div>
  ),
  th: ({ children, align }) => (
    <th style={{ ...tableCell(align), background: 'rgba(0,0,0,0.03)', whiteSpace: 'nowrap' }}>{children}</th>
  ),
  td: ({ children, align }) => <td style={tableCell(align)}>{children}</td>,
}

export function Markdown({ text }: { readonly text: string }): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, whiteSpace: 'normal', wordBreak: 'break-word' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
