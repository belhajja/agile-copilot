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

  const csv = await page.request.get('/api/audit/export?format=csv');
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect(await csv.text()).toContain('workspace.settings_changed');
  const json = await page.request.get('/api/audit/export?format=json');
  expect(json.headers()['content-type']).toContain('application/x-ndjson');
  const lines = (await json.text()).trimEnd().split('\n');
  expect(lines.map((l) => JSON.parse(l).action)).toContain('audit.exported');

  // Signed out: the proxy answers 401.
  const anon = await page.context().browser()?.newContext({ baseURL: page.url() });
  const res = await anon?.request.get('/api/audit/export?format=csv');
  expect(res?.status()).toBe(401);
  await anon?.close();
});
