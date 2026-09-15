import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * 六层依赖规则（docs/design/abstraction.md §2）：依赖只向内。
 * 违规即 lint 失败；历史违规计数门禁见 scripts/import-ratchet.mjs。
 */
const restrict = (message, group) => ({
  'no-restricted-imports': ['error', { patterns: [{ group, message }] }],
})

const NODE_BUILTIN = ['node:*', 'node:**']

/** 脚本与工程配置文件（.mjs/.js）的 Node 全局：不引 globals 依赖，按需声明 */
const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
}

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'web/dist/**',
      'data/**',
      'coverage/**',
      '.npm-cache/**',
      '.test-tmp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: NODE_GLOBALS },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: restrict('shared 层只能依赖自身，不得依赖其它层（abstraction.md §2）', [
      '**/ports/**',
      '**/ports',
      '**/domain/**',
      '**/domain',
      '**/application/**',
      '**/application',
      '**/infra/**',
      '**/infra',
      '**/server/**',
      '**/server',
      '**/bootstrap/**',
      '**/bootstrap',
      ...NODE_BUILTIN,
    ]),
  },
  {
    files: ['src/ports/**/*.ts'],
    rules: restrict('ports 层只能依赖 shared（abstraction.md §2）', [
      '**/domain/**',
      '**/domain',
      '**/application/**',
      '**/application',
      '**/infra/**',
      '**/infra',
      '**/server/**',
      '**/server',
      '**/bootstrap/**',
      '**/bootstrap',
      ...NODE_BUILTIN,
    ]),
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: restrict('domain 层只能依赖 shared 与 ports 的类型（abstraction.md §2）', [
      '**/application/**',
      '**/application',
      '**/infra/**',
      '**/infra',
      '**/server/**',
      '**/server',
      '**/bootstrap/**',
      '**/bootstrap',
      ...NODE_BUILTIN,
    ]),
  },
  {
    files: ['src/application/**/*.ts'],
    rules: restrict('application 层不得依赖 infra / server / bootstrap，也不得直接用 node 内建（abstraction.md §2）', [
      '**/infra/**',
      '**/infra',
      '**/server/**',
      '**/server',
      '**/bootstrap/**',
      '**/bootstrap',
      ...NODE_BUILTIN,
    ]),
  },
  {
    files: ['src/infra/**/*.ts'],
    rules: restrict('infra 层不得依赖 application / server / bootstrap（abstraction.md §2）', [
      '**/application/**',
      '**/application',
      '**/server/**',
      '**/server',
      '**/bootstrap/**',
      '**/bootstrap',
    ]),
  },
  {
    files: ['src/server/**/*.ts'],
    rules: restrict('server 层不得依赖 infra 与 domain（静态资源也走端口，abstraction.md §2）', [
      '**/infra/**',
      '**/infra',
      '**/domain/**',
      '**/domain',
      '**/bootstrap/**',
      '**/bootstrap',
    ]),
  },
  {
    files: ['web/src/**/*.ts', 'web/src/**/*.tsx'],
    rules: restrict('前端不得直接依赖服务端源码，只能经 REST/WS 契约交互（abstraction.md §2）', [
      '**/src/**',
      ...NODE_BUILTIN,
    ]),
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // 测试允许引用任意层做集成/契约测试
      'no-restricted-imports': 'off',
    },
  },
)
