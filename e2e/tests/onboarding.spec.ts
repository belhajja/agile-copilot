import { expect, test } from '@playwright/test';
import { signUpWithWorkspace } from '../helpers';

test('signed-out visitors are sent to login, which remembers the page', async ({ page }) => {
  await page.goto('/settings/jira');
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fjira$/);
});

test('mismatched passwords are caught before sign-up', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Pat');
  await page.getByLabel('Email').fill(`pm+${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByLabel('Confirm password').fill('correct-horse-batterz');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Passwords do not match.')).toBeVisible();
});

test('a new manager signs up and lands on the get-started checklist', async ({ page }) => {
  await signUpWithWorkspace(page);
  await expect(page.getByText('Connect Jira')).toBeVisible();
  await expect(page.getByText('To do').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Acme Delivery/ })).toBeVisible(); // workspace switcher
});

test('the interface switches to French from the user menu', async ({ page }) => {
  await signUpWithWorkspace(page);
  await page.getByRole('button', { name: /Pat Manager/ }).click();
  await page.getByRole('menuitem', { name: 'Français' }).click();
  await expect(page.getByRole('heading', { name: 'Pour commencer' })).toBeVisible();
});
