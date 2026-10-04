import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'analytics-mcp',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
