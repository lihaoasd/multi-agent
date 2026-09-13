import type { FastifyInstance } from 'fastify'
import type { Services } from '../../application/composition.js'

export function registerArtifactRoutes(app: FastifyInstance, svc: Services): void {
  const { artifacts } = svc

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/artifacts', async (req) => ({
    artifacts: await artifacts.list(req.params.pid),
  }))

  app.get<{ Params: { pid: string; aid: string } }>(
    '/api/projects/:pid/artifacts/:aid',
    async (req) => {
      const rec = await artifacts.get(req.params.pid, req.params.aid)
      return {
        artifact: rec,
        versions: await artifacts.listVersions(req.params.pid, req.params.aid),
      }
    },
  )

  app.post<{ Params: { pid: string; aid: string }; Body: { toVersion?: number } }>(
    '/api/projects/:pid/artifacts/:aid/rollback',
    async (req) => {
      const rec = await artifacts.rollback(req.params.pid, req.params.aid, req.body?.toVersion)
      return { artifact: rec }
    },
  )
}

export function registerMemorySearchRoutes(app: FastifyInstance, svc: Services): void {
  const { memory, search } = svc

  app.get<{
    Params: { pid: string }
    Querystring: { q?: string; scope?: string; instanceId?: string; type?: string; limit?: string }
  }>('/api/projects/:pid/search', async (req) => {
    const q = req.query.q ?? ''
    if (!q.trim()) return { q: '', sessions: [], memories: [] }
    return search.search(req.params.pid, q)
  })

  // 记忆列表（只读浏览 MVP；M1 版本见 contract）
  app.get<{
    Params: { pid: string }
    Querystring: { scope?: string; instanceId?: string; type?: string; limit?: string }
  }>('/api/projects/:pid/memories', async (req) => {
    const scope = req.query.scope === 'role' ? 'role' : 'global'
    const entries = await memory.listActive(req.params.pid, {
      scope,
      instanceId: req.query.instanceId,
      type: req.query.type as never,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    })
    return { entries }
  })
}

