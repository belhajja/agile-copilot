import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'db',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 300_000,
    testTimeout: 30_000,
  },
});
