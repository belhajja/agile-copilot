import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'llm', environment: 'node', include: ['src/**/*.test.ts'] },
});
