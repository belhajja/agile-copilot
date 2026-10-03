import { expect, type Page, test } from '@playwright/test';
import { signUpWithWorkspace } from '../helpers';

async function signIn(page: Page, email: string, password: string, labels = EN) {
  await page.getByLabel(labels.email).fill(email);
  await page.getByLabel(labels.password).fill(password);
  await page.getByRole('button', { name: labels.signIn }).click();
}

const EN = { email: 'Email', password: 'Password', signIn: 'Sign in' };
const FR = { email: 'E-mail', password: 'Mot de passe', signIn: 'Se connecter' };

test('an existing user signs back in; a wrong password shows a translated error', async ({
  page,
}) => {
  const { email } = await signUpWithWorkspace(page);

  await page.getByRole('button', { name: /Pat Manager/ }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await signIn(page, email, 'wrong-password-123');
  await expect(page.getByText('Invalid email or password.')).toBeVisible();

  await signIn(page, email, 'correct-horse-battery');
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();

  // Same failure in French: the locale cookie outlives the session.
  await page.getByRole('button', { name: /Pat Manager/ }).click();
  await page.getByRole('menuitem', { name: 'Français' }).click();
  await expect(page.getByRole('heading', { name: 'Pour commencer' })).toBeVisible();
  await page.getByRole('button', { name: /Pat Manager/ }).click();
  await page.getByRole('menuitem', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await signIn(page, email, 'wrong-password-123', FR);
  await expect(page.getByText('E-mail ou mot de passe incorrect.')).toBeVisible();
});
