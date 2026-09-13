import { registerTool } from '../../../infra/tools/executor.js'
import type { ServiceToolDeps } from './context.js'

/** 会议工具：`meeting_start`（任意角色可发起）/ `meeting_close` / `meeting_talk`（主持人点名）。 */
export function registerPlatformTools(deps: ServiceToolDeps): void {
  const { meetings, listTeam, runMeetingChain, meetingsEnabled } = deps
  if (meetings && listTeam && meetingsEnabled) {
      registerTool(
        {
          name: 'meeting_start',
          description:
            '发起会议（任意角色）：给定主题、描述与参会人（不含自己）；平台会代受邀 AI 成员接受并进入会议，用户可插话/拍板/结束',
          scope: 'platform',
          availableIn: ['user'],
          idempotent: false,
          paramsSchema: {
            type: 'object',
            properties: {
              topic: { type: 'string', description: '会议主题' },
              desc: { type: 'string', description: '会议描述：为什么开、期望产出' },
              members: {
                type: 'array',
                items: { type: 'string' },
                description: '参会角色实例 id（如 dev_1、qa_1；不含自己）',
              },
              agenda: { type: 'array', items: { type: 'string' }, description: '议题（可选）' },
            },
            required: ['topic', 'members'],
          },
        },
        async (args, env) => {
          const topic = String(args.topic ?? '').trim()
          const desc = args.desc === undefined ? '' : String(args.desc).trim()
          const members = (Array.isArray(args.members) ? args.members.map(String) : [])
            .map((s) => s.trim())
            .filter(Boolean)
          const agenda = (Array.isArray(args.agenda) ? args.agenda.map(String) : [])
            .map((s) => s.trim())
            .filter(Boolean)
          if (!topic) return { ok: false, code: 'ERR_VALIDATION', reason: 'topic 必填' }
          if (!members.length)
            return { ok: false, code: 'ERR_VALIDATION', reason: 'members 至少 1 人' }
          if (members.includes(env.instanceId)) {
            return { ok: false, code: 'ERR_VALIDATION', reason: '你是主持人，members 不要包含自己' }
          }
          const team = await listTeam(env.projectId)
          const enabled = team.filter((m) => m.enabled).map((m) => m.instanceId)
          const bad = members.filter((m) => !enabled.includes(m))
          if (bad.length) {
            return {
              ok: false,
              code: 'ERR_VALIDATION',
              reason: `实例不存在或已停用：${bad.join('、')}（可选：${enabled.join('、')}）`,
            }
          }
          try {
            const rec = await meetings.create({
              projectId: env.projectId,
              host: env.instanceId,
              topic,
              desc,
              agenda,
              members,
            })
            // 平台代受邀 AI 成员接受邀请 → 会议进入 open（占用=会议中）
            for (const m of members) {
              await meetings.respond(env.projectId, rec.id, m, 'accept').catch(() => undefined)
            }
            // 同一时刻只允许一个会议进行：已有占槽会议时本条落 `queued`，等它结束再自动开始
            const current = (await meetings.list(env.projectId)).find((m) => m.id === rec.id)
            const queued = current?.state === 'queued'
            // 会议开场/发言/收尾链（后台串行，不阻塞本回合）。
            // **排队等待的会议不在这里开场**：同一个时刻只允许一个会议进行，等槽位空出、被
            // promoteQueuedIfFree 提升时，再由组合根的 onPromoted 用同一个 runMeetingChain 开场。
            if (runMeetingChain && !queued) {
              void runMeetingChain({
                projectId: env.projectId,
                meeting: rec,
                topic,
                desc,
                members,
                host: env.instanceId,
              }).catch(() => undefined)
            }
            return {
              ok: true,
              summary: queued
                ? `已有会议在进行（同一时刻只允许一个会议），会议 ${rec.id}「${topic}」已**发起并排队等待**：` +
                  '等当前会议结束后平台会自动开始并通知你，你**本轮就到这里**，不要反复重试发起、也不要自己拉人开会。'
                : `已发起会议 ${rec.id}「${topic}」，参会：我（${env.instanceId}，主持）、${members.join('、')}、用户。` +
                  '会议已开始；请在会议会话中跟进结论，结束后用 meeting_close 收尾（会生成纪要）。',
            }
          } catch (e) {
            return {
              ok: false,
              code:
                e instanceof Error && 'code' in e
                  ? String((e as { code: string }).code)
                  : 'ERR_CONFLICT',
              reason: e instanceof Error ? e.message : String(e),
            }
          }
        },
      )

      registerTool(
        {
          name: 'meeting_close',
          description: '结束你主持的会议并生成纪要（仅主持人）',
          scope: 'platform',
          availableIn: ['user'],
          idempotent: false,
          paramsSchema: {
            type: 'object',
            properties: { meetingId: { type: 'string', description: '会议 id（m_…）' } },
            required: ['meetingId'],
          },
        },
        async (args, env) => {
          const meetingId = String(args.meetingId ?? '').trim()
          if (!meetingId) return { ok: false, code: 'ERR_VALIDATION', reason: 'meetingId 必填' }
          try {
            const rec = (await meetings.list(env.projectId)).find((m) => m.id === meetingId)
            if (!rec) return { ok: false, code: 'ERR_NOT_FOUND', reason: `会议不存在: ${meetingId}` }
            if (rec.meeting.host !== env.instanceId) {
              return { ok: false, code: 'ERR_TOOL_REJECTED', reason: '只有主持人才可以结束会议' }
            }
            await meetings.close(env.projectId, meetingId, env.instanceId)
            return { ok: true, summary: `已结束会议 ${meetingId}，纪要已生成` }
          } catch (e) {
            return {
              ok: false,
              code:
                e instanceof Error && 'code' in e
                  ? String((e as { code: string }).code)
                  : 'ERR_CONFLICT',
              reason: e instanceof Error ? e.message : String(e),
            }
          }
        },
      )

      // 主持人点名某位参会成员在会议中发言（触发其在会议会话里发言）
      registerTool(
        {
          name: 'meeting_talk',
          description:
            '主持人点名某位参会成员在会议中发言：会触发该成员在会议会话里发言（发言写入会议记录）',
          scope: 'platform',
          availableIn: ['user'],
          idempotent: false,
          paramsSchema: {
            type: 'object',
            properties: {
              meetingId: { type: 'string', description: '会议 id（m_…）' },
              member: { type: 'string', description: '被点名的参会成员实例 id（不能是自己）' },
              question: { type: 'string', description: '可选：请他就某个具体问题表态' },
            },
            required: ['meetingId', 'member'],
          },
        },
        async (args, env) => {
          const meetingId = String(args.meetingId ?? '').trim()
          const member = String(args.member ?? '').trim()
          if (!meetingId || !member) {
            return { ok: false, code: 'ERR_VALIDATION', reason: 'meetingId/member 必填' }
          }
          try {
            await meetings.speakTurn(
              env.projectId,
              meetingId,
              env.instanceId,
              member,
              args.question === undefined ? undefined : String(args.question),
            )
            return {
              ok: true,
              summary: `已邀请 ${member} 在会议 ${meetingId} 发言（发言将写入会议会话）`,
            }
          } catch (e) {
            return {
              ok: false,
              code:
                e instanceof Error && 'code' in e
                  ? String((e as { code: string }).code)
                  : 'ERR_CONFLICT',
              reason: e instanceof Error ? e.message : String(e),
            }
          }
        },
      )
  }
}
