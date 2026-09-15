import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只跑源码里的测试。dist/ 是 tsc 的编译产物，跑它等于把同一批用例
    // 跑两遍，还会因为编译时机不同产生莫名其妙的失败。
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'agent', 'web'],
  },
})
