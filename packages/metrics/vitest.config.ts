import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'metrics', environment: 'node', include: ['src/**/*.test.ts'] },
});
