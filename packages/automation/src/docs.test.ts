import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUN_SKIP_CODES } from './codes';
import { DEFAULT_DAILY_RUN_LIMIT, ownerRunShare, SKILL_MANUAL_RUNS_PER_USER } from './runs';

const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

describe('the README states the run limits the code enforces (P4-R30)', () => {
  it('names each limit, its code and its numbers', () => {
    for (const code of RUN_SKIP_CODES) expect(readme).toContain(`\`${code}\``);
    expect(readme).toContain(
      `at most **${SKILL_MANUAL_RUNS_PER_USER} times per rolling 24 hours**`,
    );
    expect(readme).toContain('`max(5, ceil(limit / 2))`');
    expect(readme).toContain(
      `${ownerRunShare(DEFAULT_DAILY_RUN_LIMIT)} of the default ${DEFAULT_DAILY_RUN_LIMIT}`,
    );
  });
});
