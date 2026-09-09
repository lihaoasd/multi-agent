/**
 * Mock 模型 Provider：无网络、确定性，供开发/测试/首次体验（deploy.md §1）。
 * 行为：把最后一条 user 消息回显包装为"角色应答"风格文本，逐段流式输出。
 */
import type { ChatMessage, ModelProvider } from './provider.js'

export function createMockProvider(id = 'mock'): ModelProvider {
  return {
    id,
    kind: 'mock',
    async *streamChat({ messages }) {
      const user = [...messages].reverse().find((m) => m.role === 'user')
      const sys = messages.find((m) => m.role === 'system')?.content ?? ''
      const roleHint = extractRoleName(sys)
      const text = user
        ? `（Mock · ${roleHint}）已收到你的消息：「${trim(user.content, 200)}」。这是本地 Mock 模型的确定性回复——接入真实模型（DeepSeek/Ollama）后此处为实际生成内容。`
        : `（Mock · ${roleHint}）你好，我是本地演示助手。`
      // 分片流式输出（模拟增量；每片 4~12 字符，即时返回）
      const size = 12
      for (let i = 0; i < text.length; i += size) {
        yield text.slice(i, i + size)
        // 不 sleep：测试确定性；真实流由网络节奏决定
      }
    },
  }
}

function extractRoleName(systemPrompt: string): string {
  const m = /你是([^\n。；，,]{1,24})/.exec(systemPrompt)
  return m?.[1] ?? 'Agent'
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function asChatText(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n')
    .slice(0, 2000)
}
