import { expect, test } from '@playwright/test';
import { joinAsMember, orgIdOf, signUp, signUpWithWorkspace } from '../helpers';

// Two people sign up and act in turn: on a loaded CI runner that alone can take the default 30 s.
test.describe.configure({ timeout: 120_000 });

test('an owner invites with a role, changes a role and removes a member', async ({
  page,
  browser,
}) => {
  const { email: ownerEmail } = await signUpWithWorkspace(page);
  await page.goto('/settings/members');
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  // The owner has no controls on their own row. e2e runs with SSO (accepting needs an
  // IdP-verified address), so the page does not warn about link possession.
  await expect(page.locator(`[data-member="${ownerEmail}"] [data-role="owner"]`)).toBeVisible();
  await expect(page.getByText('Without single sign-on', { exact: false })).toHaveCount(0);

  // Invite: the owner role is offered (owners may give it), the default is viewer.
  const invited = `invited+${Date.now()}@example.com`;
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('viewer');
  await page.getByLabel('E-mail').fill(invited);
  await page.getByLabel('Role', { exact: true }).selectOption('manager');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const pending = page.locator(`[data-invitation="${invited}"]`);
  await expect(pending).toBeVisible();
  await expect(pending.getByText('Manager')).toBeVisible();
  // The same address twice is refused with a translated sentence.
  await page.getByLabel('E-mail').fill(invited);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(page.getByText('This person already has a pending invitation.')).toBeVisible();

  // Cancel it.
  await pending.getByRole('button', { name: 'Cancel invitation' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel invitation' }).click();
  await expect(pending).toHaveCount(0);

  // A second person joins (as a viewer); the owner promotes then removes them.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  const { email } = await signUp(otherPage, 'Sam Viewer');
  await joinAsMember(email, await orgIdOf(ownerEmail));
  await page.reload();
  const row = page.locator(`[data-member="${email}"]`);
  await expect(row.locator('[data-role="viewer"]')).toBeVisible();
  await row.getByLabel('Role of Sam Viewer').selectOption('admin');
  await expect(row.locator('[data-role="admin"]')).toBeVisible();

  // The new admin sees the controls but cannot give the owner role.
  await otherPage.goto('/settings/members');
  await expect(otherPage.getByLabel('Role', { exact: true }).locator('option')).toHaveText([
    'Admin',
    'Manager',
    'Viewer',
  ]);
  await expect(otherPage.locator(`[data-member="${ownerEmail}"]`).getByRole('button')).toHaveCount(
    0,
  );

  await row.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0);
  await other.close();
});

test('a viewer sees the list read-only', async ({ page, browser }) => {
  const { email: ownerEmail } = await signUpWithWorkspace(page);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  const { email } = await signUp(otherPage, 'Vic Viewer');
  await joinAsMember(email, await orgIdOf(ownerEmail));
  await otherPage.goto('/settings/members');
  await expect(otherPage.locator(`[data-member="${ownerEmail}"]`)).toBeVisible();
  await expect(otherPage.getByText('Only owners and admins manage members.')).toBeVisible();
  await expect(otherPage.getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0);
  await expect(otherPage.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await other.close();
});
