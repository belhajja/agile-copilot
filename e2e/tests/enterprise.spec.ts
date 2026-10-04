import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { signUp, signUpWithWorkspace } from '../helpers';

// SSO through the mock OIDC provider (`pnpm mocks`, 4090), invitations and roles, audit export,
// external MCP tokens, personal data export and account deletion. Self-host billing (no page, no
// link, webhook 404) is billing.spec.ts; the owner's audit download in both formats is
// workspace.spec.ts; the manager's approval and the viewer's analytics-only assistant are
// agent.spec.ts.
test.describe.configure({ mode: 'serial', timeout: 240_000 });

interface OidcUser {
  sub: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

/** Who the mock identity provider signs in next. */
async function nextSsoUser(user: OidcUser) {
  const res = await fetch('http://127.0.0.1:4010/__mock/oidc-user', {
    method: 'POST',
    body: JSON.stringify(user),
  });
  expect(res.status).toBe(204);
}

/** Our own origin: the export routes take POSTs from our pages only (A-m5). */
const SAME_ORIGIN = { origin: 'http://localhost:3200' };

const unique = (prefix: string) =>
  `${prefix}+${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

/**
 * The web server may have started before the mock IdP (Playwright starts them together): the app
 * then retries discovery every 30 s, and the button is enabled once it succeeded.
 */
async function signInWithSso(page: Page) {
  const button = page.getByRole('button', { name: 'Continue with Acme SSO' });
  await expect(async () => {
    await page.goto('/login');
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 90_000, intervals: [2_000] });
  await button.click();
}

/** A raw JSON-RPC `tools/list` call to the external MCP endpoint, as an MCP client sends it. */
const mcpCall = (page: Page, token: string) =>
  page.request.post('/api/mcp', {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });

/** Turns the workspace's external MCP switch on or off (owners and admins). */
async function setExternalMcp(page: Page, on: boolean) {
  await page.goto('/settings/workspace');
  await page.getByLabel('Allow external AI clients (MCP)').setChecked(on);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
}

/** Keys that must never leave in a personal data export (credentials, tokens, key material). */
const SECRET_KEYS = new Set([
  'secret',
  'password',
  'token',
  'token_hash',
  'tokenHash',
  'wrapped_dek',
  'wrappedDek',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'idToken',
]);

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  }
  return into;
}

const overflowOf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('SSO joins by invitation; roles, audit export, MCP tokens and account deletion', async ({
  page,
  browser,
}) => {
  await signUpWithWorkspace(page);

  // The owner invites a teammate as Manager.
  const email = unique('sasha');
  await page.goto('/settings/members');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Role', { exact: true }).selectOption('manager');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(page.locator(`[data-invitation="${email}"]`)).toBeVisible();

  // The teammate signs in with SSO for the first time (IdP-verified address) and accepts from
  // onboarding.
  await nextSsoUser({ sub: `kc-${Date.now()}`, email, name: 'Sasha Sso', emailVerified: true });
  const context = await browser.newContext();
  const sso = await context.newPage();
  await signInWithSso(sso);
  await expect(sso).toHaveURL(/\/onboarding$/);
  const invitation = sso.locator('[data-invitation]');
  await expect(invitation.getByText('Acme Delivery')).toBeVisible();
  await expect(invitation.getByText('Manager')).toBeVisible();
  await invitation.getByRole('button', { name: 'Accept' }).click();
  await expect(sso.getByRole('heading', { name: 'Get started' })).toBeVisible();

  // The owner sees the manager and turns them into a viewer.
  await page.reload();
  const row = page.locator(`[data-member="${email}"]`);
  await expect(row.locator('[data-role="manager"]')).toHaveText('Manager');
  await row.getByLabel('Role of Sasha Sso').selectOption('viewer');
  await expect(row.locator('[data-role="viewer"]')).toHaveText('Viewer');
  await sso.goto('/settings/members');
  await expect(sso.getByText('Only owners and admins manage members.')).toBeVisible();
  await expect(sso.getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0);

  // Audit export: owners and admins only, streamed as a download.
  const csv = await page.request.post('/api/audit/export', {
    form: { format: 'csv' },
    headers: SAME_ORIGIN,
  });
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-disposition']).toContain('attachment');
  const log = await csv.text();
  expect(log.split('\r\n')[0]).toBe(
    'created_at,action,actor_user_id,actor_name,actor_email,target_type,target_id,metadata',
  );
  for (const action of ['member.invited', 'member.joined', 'member.role_changed']) {
    expect(log).toContain(action);
  }
  const refused = await sso.request.post('/api/audit/export', {
    form: { format: 'csv' },
    headers: SAME_ORIGIN,
  });
  expect(refused.status()).toBe(403);
  expect(await refused.text()).not.toContain('member.invited');

  // External MCP: off until an admin allows it; then the viewer creates a token (shown once) and
  // a client reads the analytics tools with it.
  await sso.goto('/settings/mcp');
  await expect(sso.locator('[data-mcp-unavailable="mcp_disabled"]')).toBeVisible();
  await setExternalMcp(page, true);
  await sso.reload();
  await sso.getByLabel('Name').fill('Claude Desktop');
  await sso.getByRole('button', { name: 'Create token' }).click();
  const token = (await sso.locator('[data-new-token]').innerText()).trim();
  expect(token).toMatch(/^acp_/);
  await sso.reload();
  await expect(sso.locator('[data-token="Claude Desktop"]')).toBeVisible();
  await expect(sso.locator('[data-new-token]')).toHaveCount(0);
  await expect(sso.getByText(token)).toHaveCount(0);

  const listed = await mcpCall(sso, token);
  expect(listed.status()).toBe(200);
  const tools = JSON.stringify(await listed.json());
  expect(tools).toContain('list_boards');
  expect(tools).not.toContain('jira_'); // analytics only, never a Jira tool
  const forged = `${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}`;
  expect((await mcpCall(sso, forged)).status()).toBe(401);

  // The switch is re-checked on every request: off again, the same token is refused.
  await setExternalMcp(page, false);
  expect((await mcpCall(sso, token)).status()).toBe(401);
  await setExternalMcp(page, true);
  expect((await mcpCall(sso, token)).status()).toBe(200);

  // The owner revokes it: the client is out at once.
  await page.goto('/settings/mcp');
  await page
    .locator('[data-token="Claude Desktop"]')
    .getByRole('button', { name: 'Revoke' })
    .click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.locator('[data-token="Claude Desktop"]').getByText('Revoked')).toBeVisible();
  expect((await mcpCall(sso, token)).status()).toBe(401);

  // The teammate downloads their data (no credentials, tokens or key material), then deletes
  // their account (their SSO session is fresh).
  await sso.goto('/settings/account');
  const [exported] = await Promise.all([
    sso.waitForEvent('download'),
    sso.getByRole('button', { name: 'Download my data (JSON)' }).click(),
  ]);
  expect(exported.suggestedFilename()).toMatch(/^agile-copilot-my-data-.*\.json$/);
  const raw = await readFile(await exported.path(), 'utf8');
  const data = JSON.parse(raw) as {
    user: { email: string };
    signInMethods: { providerId: string }[];
    workspaces: unknown[];
  };
  expect(data.user.email).toBe(email);
  expect(data.signInMethods.map((m) => m.providerId)).toEqual(['oidc']);
  expect(data.workspaces).toHaveLength(1);
  expect([...keysOf(data)].filter((k) => SECRET_KEYS.has(k))).toEqual([]);
  expect(raw).not.toContain(token);
  expect(raw).not.toContain(token.split('.')[1] ?? token);

  await sso.goto('/settings/account');
  await sso.getByLabel(`Type ${email} to confirm`).fill(email);
  await sso.getByRole('button', { name: 'Delete my account' }).click();
  await expect(sso).toHaveURL(/\/login/);
  await sso.goto('/settings/account');
  await expect(sso).toHaveURL(/\/login\?next=%2Fsettings%2Faccount$/);
  await page.goto('/settings/members');
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(page.locator(`[data-member="${email}"]`)).toHaveCount(0);
  await context.close();
});

test('an SSO login never takes over a password account; its owner links SSO explicitly', async ({
  page,
  browser,
}) => {
  const { email } = await signUp(page, 'Pat Password');
  const sub = `kc-${Date.now()}`;
  await nextSsoUser({ sub, email, name: 'Impostor', emailVerified: true });
  const context = await browser.newContext();
  const sso = await context.newPage();
  await signInWithSso(sso);
  await expect(sso).toHaveURL(/\/login\?error=account_not_linked/);
  await expect(
    sso.getByText('An account with this address already exists.', { exact: false }),
  ).toBeVisible();
  // Only known codes are explained; anything else (e.g. a prototype key) reads as a generic error.
  await sso.goto('/login?error=constructor');
  await expect(sso.getByText('Something went wrong. Please try again.')).toBeVisible();

  // Signed in with their password, the owner of the address links SSO from Account.
  await nextSsoUser({ sub, email, name: 'Pat Password', emailVerified: true });
  await page.goto('/settings/account');
  await expect(page.locator('[data-sign-in-methods]').getByText('Password')).toBeVisible();
  await page.getByRole('button', { name: 'Link Acme SSO' }).click();
  await expect(page).toHaveURL(/\/settings\/account\?linked=1$/);
  await expect(page.getByText('Acme SSO is now linked to your account.')).toBeVisible();
  await expect(page.locator('[data-sign-in-methods]').getByText('Acme SSO')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Link Acme SSO' })).toHaveCount(0);

  // From now on SSO opens that same account (no workspace yet: onboarding).
  await signInWithSso(sso);
  await expect(sso).toHaveURL(/\/onboarding$/);
  await sso.goto('/settings/account');
  await expect(sso.getByText(email, { exact: true })).toBeVisible();
  await context.close();
});

test('the new settings pages fit a phone screen', async ({ page }) => {
  await signUpWithWorkspace(page);
  // Something in each list: a pending invitation (a long address) and an MCP token.
  await page.goto('/settings/members');
  const invited = unique('a-rather-long-invited-address-for-small-screens');
  await page.getByLabel('E-mail').fill(invited);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(page.locator(`[data-invitation="${invited}"]`)).toBeVisible();
  await setExternalMcp(page, true);

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/settings/mcp');
  await page.getByLabel('Name').fill('Claude Desktop on my phone');
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.locator('[data-new-token]')).toBeVisible();
  await expect.poll(() => overflowOf(page)).toBeLessThanOrEqual(0);

  // Billing exists only in SaaS builds (404 here, see billing.spec.ts).
  for (const [path, heading] of [
    ['/settings/members', 'Members'],
    ['/settings/workspace', 'Workspace settings'],
    ['/settings/audit', 'Audit log'],
    ['/settings/mcp', 'External AI clients (MCP)'],
    ['/settings/account', 'Account'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect.poll(() => overflowOf(page), { message: path }).toBeLessThanOrEqual(0);
  }
});
