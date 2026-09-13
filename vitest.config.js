/**
 * Vitest 配置（显式声明，2026-09-13）。
 *
 * 为什么需要它：本项目**没有** vitest 配置时，vitest 按默认 include 扫描整个仓库，
 * 会把 `data/projects/<pid>/artifact-versions/**` 里**角色运行时产出的** `*.test.js`（交付物副本）
 * 一并收集执行——它们依赖各自交付物的运行环境，必然失败，让 `npm run test` 出现与项目代码无关的红。
 * 项目自己的用例只在 `tests/`，这里同时排除运行时数据目录（data/）与编译产物（dist/）。
 *
 * 注意：这里**不 import `vitest/config`**，直接导出普通对象。
 * 受限环境下 Vite 打包配置文件需要解析外部依赖（rolldown externalize-deps → spawn），会 EPERM；
 * 零依赖的普通对象配置无需解析，能正常加载。字段与 vitest 的 `test` 配置一一对应。
 */
export default {
  test: {
    include: ['tests/**/*.test.{ts,js}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      // 项目自己的运行时数据（含角色交付物副本里的 *.test.js）与编译产物
      'data/**',
      'dist/**',
    ],
  },
}
