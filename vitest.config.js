import { defineConfig } from 'vitest/config'

// 测试分层见 docs/testing/plan.md：单测（domain/shared）+ 集成（infra/application）+ E2E（Mock 剧本）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    restoreMocks: true,
  },
})
