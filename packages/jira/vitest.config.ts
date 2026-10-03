import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'jira', environment: 'node', include: ['src/**/*.test.ts'] },
});
