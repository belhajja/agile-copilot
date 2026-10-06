import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'operator', environment: 'node', include: ['src/**/*.test.ts'] },
});
