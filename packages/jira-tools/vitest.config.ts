import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'jira-tools',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
