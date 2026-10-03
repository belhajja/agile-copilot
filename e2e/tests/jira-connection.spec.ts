import { expect, test } from '@playwright/test';
import { connectionItem, signUpWithWorkspace } from '../helpers';

test('connect a Jira Data Center server with a personal access token', async ({ page }) => {
  await signUpWithWorkspace(page);
  await page.getByRole('link', { name: 'Jira', exact: true }).click();

  await page.getByLabel('Connection name').fill('Corp Jira');
  await page.getByLabel('Jira URL').fill('http://127.0.0.1:4010/browse/ABC-1');
  await page.getByLabel('Data Center / Server').check();
  await page.getByLabel('Personal access token').fill('wrong-pat');
  await page.getByRole('button', { name: 'Test and save' }).click();
  await expect(page.getByText('Jira rejected these credentials.')).toBeVisible();

  await page.getByLabel('Personal access token').fill('  good-pat  ');
  await page.getByRole('button', { name: 'Test and save' }).click();
  const card = connectionItem(page, 'Corp Jira');
  await expect(card.getByText('Connected')).toBeVisible();
  await expect(card.getByText('Pat DC')).toBeVisible();
  await expect(card.getByText('http://127.0.0.1:4010')).toBeVisible();

  await page.goto('/');
  await expect(page.getByText('Done').first()).toBeVisible();
});

test('the same Jira URL cannot be connected twice', async ({ page }) => {
  await signUpWithWorkspace(page);
  await page.goto('/settings/jira');
  for (let i = 0; i < 2; i++) {
    await page.getByLabel('Connection name').fill(`Corp ${i}`);
    await page.getByLabel('Jira URL').fill('http://127.0.0.1:4010');
    await page.getByLabel('Data Center / Server').check();
    await page.getByLabel('Personal access token').fill('good-pat');
    await page.getByRole('button', { name: 'Test and save' }).click();
    // Wait for the first save to land (the form resets on success) before typing the second attempt.
    if (i === 0) await expect(connectionItem(page, 'Corp 0').getByText('Connected')).toBeVisible();
  }
  await expect(page.getByText('This Jira site is already connected.')).toBeVisible();
});
