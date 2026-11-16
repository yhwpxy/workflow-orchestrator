import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    // 执行器相关用例依赖真实定时器模拟耗时，关闭并发避免端口/文件互相干扰
    fileParallelism: false,
  },
});
