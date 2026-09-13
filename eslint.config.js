import { defineConfig, globalIgnores } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * 分层依赖规则（2026-09-14 重构 P0-2 引入，P2/P4 逐步收紧）。
 *
 * 这里是 `docs/design/architecture.md` §1「核心逻辑与 IO/框架解耦」与 §4 分层的
 * **可执行版本**：分层不写成规则就会在两轮功能迭代内再次漂移（本次重构的起点）。
 *
 * 依赖方向（单向，不得反向）：
 *   shared      → （无内部依赖）
 *   domain      → shared
 *   ports       → 契约层，不得依赖任何实现层
 *   application → domain, shared, ports（实现只在 composition.ts 注入）
 *   infra       → domain, shared, ports
 *   server      → application 门面（composition 导出的 Services 与转出函数）, shared
 *
 * 注意：`composition.ts` 是组合根，是唯一允许同时知道 application 实现与 infra 实现的地方。
 *
 * ── 棘轮（ratchet）与 promote 记录 ──────────────────────────────────────────
 * P0 引入规则时存量违规 50 处。为了不让"规则一上就让 lint 变红"，存量模块先保持 warn，
 * 每完成一个阶段就把该层 promote 为 error：
 *
 *   · src/server/**  → error（P4 路由拆分完成，2026-09-14）
 *   · src/domain/rules/path-resolver.ts → 见 LEGACY_DOMAIN_PATH_RESOLVER（待 P2b/P3）
 *   · src/application 的部分模块 → 见 LEGACY_APPLICATION_FILES（按模块逐步 promote）
 */
const LAYER_PATTERNS = {
  domain: [
    { group: ['**/application/**'], message: 'domain 不得依赖 application（分层单向：domain ← application）' },
    { group: ['**/infra/**'], message: 'domain 不得依赖 infra（domain 只放纯逻辑，IO 一律走 src/ports 的接口）' },
    { group: ['**/ports/**'], message: 'domain 不得依赖 ports（ports 面向 application/infra 的 IO 契约）' },
    { group: ['**/server/**'], message: 'domain 不得依赖 server' },
    // 只禁**IO 类**内置模块：`node:path` 是纯运算，domain 用它无需端口抽象。
    // （P2 实测：过严的 `node:*` 全禁会逼着把纯路径规则赶到 infra，反而造成 domain→infra 反向依赖。）
    {
      group: [
        'node:fs',
        'node:fs/*',
        'node:child_process',
        'node:net',
        'node:http',
        'node:https',
        'node:dgram',
        'node:worker_threads',
        'node:cluster',
        'node:v8',
        'node:vm',
      ],
      message: 'domain 不得使用 IO 类 Node 内置模块（保持纯逻辑、可单测）',
    },
  ],
  ports: [
    {
      group: ['**/application/**', '**/infra/**', '**/server/**'],
      message: 'ports 是契约层，只依赖 shared/domain，不得依赖任何实现层',
    },
  ],
  application: [
    {
      group: ['**/infra/**'],
      message: 'application 不得直接依赖 infra 实现；请依赖 src/ports 的接口，实现只在 composition.ts 注入',
    },
    { group: ['**/server/**'], message: 'application 不得依赖 server（依赖方向：server → application）' },
  ],
  infra: [
    { group: ['**/application/**'], message: 'infra 不得依赖 application：端口契约已提到 src/ports，请依赖它（依赖倒置）' },
    { group: ['**/server/**'], message: 'infra 不得依赖 server' },
  ],
  shared: [
    {
      group: ['**/application/**', '**/infra/**', '**/server/**', '**/domain/**', '**/ports/**'],
      message: 'shared 必须是最底层：不得依赖任何其他层',
    },
  ],
  server: [
    {
      group: ['**/application/*/**'],
      message: 'server 只能依赖 application 的门面（composition 导出的 Services 与转出函数），不得深入 application 内部模块',
    },
  ],
}

/** 存量豁免模块（棘轮：保持 warn）。拆分/归位完成后逐条删除。 */
const LEGACY_APPLICATION_TS = 'src/application/**/*.ts'
const LEGACY_APPLICATION_FILES = [
  'src/application/agent-loop/**/*.ts',
  'src/application/artifact/**/*.ts',
  'src/application/attention/**/*.ts',
  'src/application/dispatcher/**/*.ts',
  'src/application/meeting/**/*.ts',
  'src/application/memory/**/*.ts',
  'src/application/project/**/*.ts',
  'src/application/question/**/*.ts',
  'src/application/record/**/*.ts',
  'src/application/roles/**/*.ts',
  'src/application/search/**/*.ts',
  'src/application/session/**/*.ts',
  'src/application/task/**/*.ts',
  'src/application/team/**/*.ts',
  'src/application/tools/**/*.ts',
  // `**/*.ts` 只匹配一层，`tools/impl/**` 需单独列出（P3d 拆 service-tools 的产物）
  'src/application/tools/impl/**/*.ts',
]
const LEGACY_DOMAIN_PATH_RESOLVER = ['src/domain/rules/path-resolver.ts']

/**
 * 规则构造器。两个关键点：
 *
 * 1. `allowTypeImports: true`（**每个 pattern 项**的属性——放规则顶层会直接配置报错）：
 *    只禁止**运行期**依赖。`import type { X } from '../infra/…'` 编译后不产生 require/import，
 *    方向问题只存在于类型层。P1c 实测：仅此一项就把 50 条 warning 降到 30 条（20 条误报）。
 * 2. `group` **不支持 `!` 取反**（实测）：所以例外只能靠结构手段（如把契约提到 `src/ports`），
 *    不能靠"用取反给某个子路径开白名单"。
 */
const restricted = (patterns) => [
  'error',
  {
    patterns: patterns.map((p) => ({
      group: p.group,
      message: p.message,
      allowTypeImports: true,
    })),
  },
]
const restrictedWarn = (patterns) => [
  'warn',
  {
    patterns: patterns.map((p) => ({
      group: p.group,
      message: p.message,
      allowTypeImports: true,
    })),
  },
]

export default defineConfig([
  globalIgnores(['dist/', 'node_modules/', 'data/', 'logs/', '.test-tmp/']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          // 允许"末尾未使用参数"：P1 起部分 store 的 `projectId` 已不参与寻址
          //（作用域由注入门面决定），保留位置参数可避免改动所有调用点。
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },

  // ── 严格层（新代码）：立即 error ──────────────────────────────────────────
  {
    files: ['src/domain/**/*.ts'],
    ignores: LEGACY_DOMAIN_PATH_RESOLVER,
    rules: { 'no-restricted-imports': restricted(LAYER_PATTERNS.domain) },
  },
  {
    files: [LEGACY_APPLICATION_TS],
    ignores: [...LEGACY_APPLICATION_FILES, 'src/application/composition.ts'],
    rules: { 'no-restricted-imports': restricted(LAYER_PATTERNS.application) },
  },
  // 组合根是唯一允许知道 infra 具体实现的地方，但仍不得依赖 server
  {
    files: ['src/application/composition.ts'],
    rules: {
      'no-restricted-imports': restricted([
        { group: ['**/server/**'], message: 'application 不得依赖 server（依赖方向：server → application）' },
      ]),
    },
  },
  { files: ['src/ports/**/*.ts'], rules: { 'no-restricted-imports': restricted(LAYER_PATTERNS.ports) } },
  { files: ['src/infra/**/*.ts'], rules: { 'no-restricted-imports': restricted(LAYER_PATTERNS.infra) } },
  { files: ['src/shared/**/*.ts'], rules: { 'no-restricted-imports': restricted(LAYER_PATTERNS.shared) } },
  // server：已 promote 为 error（P4 路由拆分完成）——只能依赖 application 门面
  {
    files: ['src/server/**/*.ts'],
    rules: { 'no-restricted-imports': restricted(LAYER_PATTERNS.server) },
  },

  // ── 棘轮豁免层（存量）：warn，阶段完成后删除对应条目 ──────────────────────
  {
    files: LEGACY_APPLICATION_FILES,
    rules: { 'no-restricted-imports': restrictedWarn(LAYER_PATTERNS.application) },
  },
  {
    files: LEGACY_DOMAIN_PATH_RESOLVER,
    rules: { 'no-restricted-imports': restrictedWarn(LAYER_PATTERNS.domain) },
  },
])
