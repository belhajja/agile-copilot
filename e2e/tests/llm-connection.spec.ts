import { expect, test } from '@playwright/test';
import { connectionItem, signUpWithWorkspace } from '../helpers';

test('connect an OpenAI-compatible model with your own key', async ({ page }) => {
  await signUpWithWorkspace(page);
  await page.getByRole('link', { name: 'AI model', exact: true }).click();

  await page.getByLabel('Provider').selectOption('openai_compatible');
  await page.getByLabel('Label').fill('Local model');
  await page.getByLabel('Model').fill('mock');
  await page.getByLabel('Base URL').fill('http://127.0.0.1:4020/v1');
  await page.getByLabel('API key').fill('wrong-key');
  await page.getByRole('button', { name: 'Test and save' }).click();
  await expect(page.getByText('The provider rejected this API key.')).toBeVisible();

  await page.getByLabel('API key').fill('good-key');
  await page.getByRole('button', { name: 'Test and save' }).click();
  const card = connectionItem(page, 'Local model');
  await expect(card.getByText('Connected')).toBeVisible();
  await expect(card.getByText('Default')).toBeVisible();
  await expect(page.getByText('good-key')).toHaveCount(0);
});
