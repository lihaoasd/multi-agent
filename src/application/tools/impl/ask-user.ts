import { registerTool } from '../../../infra/tools/executor.js'
import type { ServiceToolDeps } from './context.js'

/** `ask_user`：向用户提问/确认（confirm/single/multi/text）；成功即挂起本回合，等用户答完唤醒。 */
export function registerAskUserTool(deps: ServiceToolDeps): void {
  const { questions } = deps
  if (questions) {
      registerTool(
        {
          name: 'ask_user',
          description:
            '向用户（老板）提问/请求确认：kind=confirm 确认、single 单选、multi 多选、text 自由文本。' +
            '**要问多件事时，用一次调用传 `questions` 数组（一个问题列表，1~6 题）**——' +
            '平台会在同一张卡片里逐题呈现、用户一次答完；不要并发多次调用、也不要分多轮追问。' +
            '需要用户拍板/选择/补充信息时使用，不要替用户决定',
          scope: 'platform',
          availableIn: ['user'],
          idempotent: false,
          paramsSchema: {
            type: 'object',
            properties: {
              questions: {
                type: 'array',
                description: '问题列表（推荐用法，1~6 题）：每项 question 必填，kind 缺省 confirm',
                items: {
                  type: 'object',
                  properties: {
                    question: { type: 'string', description: '要问用户的问题' },
                    kind: { type: 'string', enum: ['confirm', 'single', 'multi', 'text'] },
                    options: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'single/multi 必填（≥2 项）；confirm 缺省「确认/取消」',
                    },
                    allowText: { type: 'boolean', description: '是否允许附加补充说明' },
                  },
                  required: ['question'],
                },
              },
              // 单题简写（只问一件事时可省略 questions）
              question: { type: 'string', description: '单题简写：要问用户的问题' },
              kind: {
                type: 'string',
                enum: ['confirm', 'single', 'multi', 'text'],
                description: '单题简写：交互形式，缺省 confirm',
              },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: '单题简写：single/multi 必填（≥2 项）',
              },
              allowText: { type: 'boolean', description: '单题简写：是否允许附加补充说明' },
            },
          },
        },
        async (args, env) => {
          const sid = env.sessionId ?? `u_${env.instanceId}`
          try {
            const { record: rec, duplicate } = await questions.ask({
              projectId: env.projectId,
              sessionId: sid,
              asker: env.instanceId,
              // 问题列表（推荐）或单题简写
              questions: Array.isArray(args.questions)
                ? (args.questions as Array<Record<string, unknown>>).map((q) => ({
                    question: String(q?.question ?? ''),
                    kind: q?.kind === undefined ? undefined : String(q.kind),
                    options: Array.isArray(q?.options) ? q.options.map(String) : undefined,
                    allowText: q?.allowText === true,
                  }))
                : undefined,
              question: args.question === undefined ? undefined : String(args.question),
              kind: args.kind === undefined ? undefined : String(args.kind),
              options: Array.isArray(args.options) ? args.options.map(String) : undefined,
              allowText: args.allowText === true,
              // 回合内发起：等回合结束（占用释放后）再广播，避免"角色还在执行/思考，卡片已弹出"
              defer: true,
            })
            const queued = rec.status === 'queued'
            const queuedCount = await questions.queuedCount(env.projectId, sid).catch(() => 0)
            const list = rec.items
              .map((it, i) => `${rec.items.length > 1 ? `${i + 1}) ` : ''}${it.question}`)
              .join('\n')
            return {
              ok: true,
              // suspend：loop 见到这个标记立即结束本回合 → 角色进入「等待你处理」，不再继续执行任务
              suspend: true,
              summary: duplicate
                ? `同一批问题已经在等你回答（${rec.id}），本轮不再重复提问。` +
                  '本轮到此结束：不要继续执行任务，等用户回答后平台会唤醒你。'
                : `已向用户提问（${rec.id}，${rec.items.length} 个问题）：\n${list}` +
                  (queued
                    ? `\n（用户手上还有 1 条待答提问，本条**排队中**，等他答完会自动弹给他）`
                    : '') +
                  '\n用户会在**同一张卡片里逐题作答、一次提交**。本轮到此结束：你现在处于「等待用户决策」状态，' +
                  '不要继续执行任务、也不要臆测用户答复；' +
                  `用户回答后平台会唤醒你继续${queuedCount > 0 ? '（你还有排队中的提问会自动继续）' : ''}。`,
            }
          } catch (e) {
            return {
              ok: false,
              code:
                e instanceof Error && 'code' in e
                  ? String((e as { code: string }).code)
                  : 'ERR_TOOL_REJECTED',
              reason: e instanceof Error ? e.message : String(e),
            }
          }
        },
      )
  }
}
