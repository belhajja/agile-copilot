import { describe, expect, it } from 'vitest';
import { UsageError } from './errors';
import { createPrompter } from './terminal';

describe('createPrompter', () => {
  const noTty = { isTTY: false } as unknown as NodeJS.ReadableStream & { isTTY?: boolean };
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;

  it('refuses to ask without a terminal, pointing at a flag or --yes', async () => {
    const prompter = createPrompter(noTty, sink);
    await expect(prompter.ask('Port to publish on')).rejects.toBeInstanceOf(UsageError);
    await expect(prompter.ask('Port to publish on')).rejects.toThrow(/run with -it/);
    await expect(prompter.ask('Port to publish on')).rejects.toThrow(/--yes/);
  });

  it('refuses to confirm without a terminal, pointing at --yes', async () => {
    const prompter = createPrompter(noTty, sink);
    await expect(prompter.confirm('Replace the database?')).rejects.toBeInstanceOf(UsageError);
    await expect(prompter.confirm('Replace the database?')).rejects.toThrow(/--yes/);
  });
});
