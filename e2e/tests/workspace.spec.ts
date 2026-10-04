import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { signUpWithWorkspace } from '../helpers';

test('owner: saves retention settings and downloads the audit log as CSV and JSON Lines', async ({
  page,
}) => {
  await signUpWithWorkspace(page);
  await page.getByRole('link', { name: 'Workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
  await page.getByLabel('Usage records (days)').fill('400');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Usage records (days)')).toHaveValue('400');

  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByText('workspace.settings_changed')).toBeVisible();

  // The page's own form (a POST): the browser downloads the streamed file.
  const download = async (name: string) => {
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name }).click(),
    ]);
    return { name: file.suggestedFilename(), text: await readFile(await file.path(), 'utf8') };
  };
  const csv = await download('Download CSV');
  expect(csv.name).toMatch(/^audit-log-.*\.csv$/);
  expect(csv.text).toContain('workspace.settings_changed');
  const json = await download('Download JSON');
  expect(json.name).toMatch(/\.jsonl$/);
  const lines = json.text.trimEnd().split('\n');
  expect(lines.map((l) => JSON.parse(l).action)).toContain('audit.exported');

  // A link or form on another site cannot start an export (A-m5): no GET, no cross-site POST.
  expect((await page.request.get('/api/audit/export?format=csv')).status()).toBe(405);
  const crossSite = await page.request.post('/api/audit/export', {
    form: { format: 'csv' },
    headers: { origin: 'https://evil.example' },
  });
  expect(crossSite.status()).toBe(403);

  // Signed out: the proxy answers 401.
  const anon = await page.context().browser()?.newContext({ baseURL: page.url() });
  const res = await anon?.request.post('/api/audit/export', {
    form: { format: 'csv' },
    headers: { origin: 'http://localhost:3200' },
  });
  expect(res?.status()).toBe(401);
  await anon?.close();
});
