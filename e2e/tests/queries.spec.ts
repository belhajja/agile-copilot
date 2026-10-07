import { expect, test } from '@playwright/test';
import { ask, setUpWorkspace } from '../helpers';

test('pin an assistant query to the dashboard', async ({ page }) => {
  await setUpWorkspace(page);
  await page.goto('/agent');
  await ask(page, 'Show the open bugs per assignee');
  await expect(page.getByText('Here are the open bugs per assignee.')).toBeVisible({
    timeout: 60_000,
  });
  const result = page.locator('[data-query-result]');
  await expect(result).toContainText('Open bugs per assignee');
  await result.getByRole('button', { name: 'Pin to dashboard' }).click();
  await result.getByRole('link', { name: 'Open the dashboard' }).click();
  await expect(page).toHaveURL(/\/boards\/[0-9a-f-]{36}$/);
  await page.getByRole('tab', { name: 'Pinned' }).click();
  const pinned = page.locator('[data-widget^="w-"]');
  await expect(pinned).toHaveCount(1);
  await expect(pinned).toContainText('Open bugs per assignee');
});
