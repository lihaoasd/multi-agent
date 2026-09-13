/**
 * 路由汇总入口（P4，2026-09-14）。
 *
 * 拆分前 `app.ts` 816 行、路由与 Fastify 组装混在一起；现在：
 *   · `app.ts`     —— 组装（插件/错误映射/静态托管/挂载路由）
 *   · `routes/*.ts` —— 按域分文件的路由注册
 *   · 本文件        —— 汇总 re-export，保持 `app.ts` 的导入路径稳定
 *
 * 分域：projects / roles-sessions / artifacts / meetings / tasks。
 */
export {
  registerProjectRoutes,
  registerTeamRoutes,
} from './routes/projects.js'
export {
  registerRoleRoutes,
  registerSessionRoutes,
  registerApprovalRoutes,
} from './routes/roles-sessions.js'
export {
  registerArtifactRoutes,
  registerMemorySearchRoutes,
} from './routes/artifacts.js'
export {
  registerMeetingRoutes,
  registerQuestionRoutes,
  registerExportRoutes,
} from './routes/meetings.js'
export {
  registerTaskRoutes,
  registerAttentionRoute,
  registerBrowseRoutes,
  registerConfigRoutes,
  registerWs,
} from './routes/tasks.js'
