import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // 集成测试共用一个测试库、开头会清表，文件之间不能并行
    fileParallelism: false,
  },
})
