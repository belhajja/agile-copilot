import { createDb } from '@agile/db';
import { expect, type Page } from '@playwright/test';
import { sql } from 'drizzle-orm';

/** Signs up a new user (lands on onboarding, without a workspace yet). */
export async function signUp(page: Page, name = 'Pat Manager'): Promise<{ email: string }> {
  const email = `pm+${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByLabel('Confirm password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  return { email };
}

export async function signUpWithWorkspace(page: Page): Promise<{ email: string }> {
  const { email } = await signUp(page);
  await page.getByLabel('Workspace name').fill('Acme Delivery');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
  return { email };
}

/** A connection row on a settings page (shadcn Item renders data-slot="item"). */
export const connectionItem = (page: Page, name: string) =>
  page.locator('[data-slot="item"]').filter({ hasText: name });

const ownerUrl =
  process.env.DATABASE_OWNER_URL ?? 'postgres://agile:agile_dev_password@localhost:5433/agile';

/** Runs one query as the database owner (audit rows and test-only membership setup). */
export async function asOwner<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const { db, close } = createDb(ownerUrl, { max: 1 });
  try {
    return (await db.execute(query)) as unknown as T[];
  } finally {
    await close();
  }
}

export async function orgIdOf(email: string) {
  const [row] = await asOwner<{ orgId: string }>(sql`
    select m.organization_id as "orgId" from member m join "user" u on u.id = m.user_id
    where u.email = ${email}`);
  if (!row) throw new Error(`no workspace for ${email}`);
  return row.orgId;
}

/**
 * Test-only stand-in for an accepted invitation (there is no invitation UI yet): it writes what
 * accepting one produces, a `member` row with role `viewer` and the session's active workspace.
 */
export async function joinAsMember(email: string, orgId: string) {
  await asOwner(sql`
    insert into member (id, organization_id, user_id, role, created_at)
    select gen_random_uuid()::text, ${orgId}, u.id, 'viewer', now() from "user" u
    where u.email = ${email}`);
  await asOwner(sql`
    update session set active_organization_id = ${orgId}
    where user_id = (select id from "user" where email = ${email})`);
}

/** A workspace with the demo Jira (DEMO Scrum synced) and the mock model as its default. */
export async function setUpWorkspace(page: Page) {
  const { email } = await signUpWithWorkspace(page);
  await page.goto('/settings/jira');
  await page.getByLabel('Connection name').fill('Demo Jira');
  await page.getByLabel('Jira URL').fill('http://127.0.0.1:4010');
  await page.getByLabel('Data Center / Server').check();
  await page.getByLabel('Personal access token').fill('good-pat');
  await page.getByRole('button', { name: 'Test and save' }).click();
  await expect(connectionItem(page, 'Demo Jira').getByText('Connected')).toBeVisible();
  await connectionItem(page, 'Demo Jira').getByRole('link', { name: 'Boards' }).click();
  await page.getByRole('button', { name: 'Load boards from Jira' }).click();
  await page.getByLabel('DEMO Scrum').check();
  await page.getByRole('button', { name: 'Save selection' }).click();
  await expect(page.getByText('Board selection saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText(/^Synced /)).toBeVisible({ timeout: 90_000 });

  await page.goto('/settings/llm');
  await page.getByLabel('Provider').selectOption('openai_compatible');
  await page.getByLabel('Label').fill('Mock model');
  await page.getByLabel('Model').fill('mock');
  await page.getByLabel('Base URL').fill('http://127.0.0.1:4020/v1');
  await page.getByLabel('API key').fill('good-key');
  await page.getByRole('button', { name: 'Test and save' }).click();
  await expect(connectionItem(page, 'Mock model').getByText('Connected')).toBeVisible();
  const prices = connectionItem(page, 'Mock model');
  await prices.getByLabel('Input, per 1M tokens').fill('3');
  await prices.getByLabel('Output, per 1M tokens').fill('15');
  await prices.getByRole('button', { name: 'Save prices' }).click();
  await expect(prices.getByText('Prices saved.')).toBeVisible();
  return { email, orgId: await orgIdOf(email) };
}

/** Sends a message in the assistant. */
export async function ask(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}
