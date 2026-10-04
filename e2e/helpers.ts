import { expect, type Page } from '@playwright/test';

export async function signUpWithWorkspace(page: Page): Promise<{ email: string }> {
  const email = `pm+${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Pat Manager');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByLabel('Confirm password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Workspace name').fill('Acme Delivery');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
  return { email };
}

/** A connection row on a settings page (shadcn Item renders data-slot="item"). */
export const connectionItem = (page: Page, name: string) =>
  page.locator('[data-slot="item"]').filter({ hasText: name });
