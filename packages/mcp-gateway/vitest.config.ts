import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'mcp-gateway',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 300_000,
    testTimeout: 60_000,
  },
});
