import { expect, type Page, test } from '@playwright/test';
import { sql } from 'drizzle-orm';
import { ask, asOwner, joinAsMember, setUpWorkspace, signUp } from '../helpers';

// Mocks (e2e/mocks/serve.ts): Jira with the demo boards on 4010, the scripted model on 4020, the
// mcp-atlassian double on 4050. The scripted model answers "velocity" with the analytics tools and
// "comment on KEY: text" with a jira_add_comment proposal (when the tool is offered).
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const jiraWrites = async (page: Page) =>
  (await (await page.request.get('http://127.0.0.1:4010/__mock/writes')).json()) as {
    method: string;
    path: string;
    body: { body?: string };
  }[];

async function auditFor(orgId: string, issueKey: string) {
  const rows = await asOwner<{ action: string }>(sql`
    select action from audit_log
    where org_id = ${orgId} and action like 'agent_action.%' and metadata->>'issueKey' = ${issueKey}
    order by created_at`);
  return rows.map((r) => r.action);
}

const velocityAnswer = 'The average velocity of DEMO Scrum is 19 points per sprint.';
const kpi = (page: Page, selector: string) => page.locator(`${selector} [data-slot="card-title"]`);
// The Usage page shows chat answers and skill runs apart: its assertions read the chat section.
const chatKpi = (page: Page, selector: string) =>
  kpi(page, `[data-usage-source="chat"] ${selector}`);

test('ask about velocity, then approve and reject proposed Jira comments', async ({ page }) => {
  const { orgId } = await setUpWorkspace(page);

  await page.getByRole('link', { name: 'Assistant' }).click();
  await expect(page.getByText('Ask about your boards')).toBeVisible({ timeout: 60_000 });

  // A question answered with the analytics tools and the demo numbers
  await ask(page, 'What is our velocity?');
  await expect(page.getByText(velocityAnswer)).toBeVisible();
  await expect(page.locator('[data-tool="get_metric"]')).toBeVisible();
  await expect(page).toHaveURL(/\/agent\/[0-9a-f-]{36}$/);

  // A proposed comment waits for approval; nothing reaches Jira before it
  const comment = `Blocked by the API team ${Date.now()}`;
  await ask(page, `Please comment on DEMO-1: ${comment}`);
  const card = page.locator('[data-approval]').last();
  await expect(card.getByText(comment)).toBeVisible();
  expect((await jiraWrites(page)).some((w) => w.body?.body === comment)).toBe(false);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Done: the comment is posted.')).toBeVisible();
  await expect(card.getByText('Approved')).toBeVisible();
  // Exactly one write with this run's text, and it stays one (a late duplicate would show here).
  const posted = async () =>
    (await jiraWrites(page))
      .filter((w) => w.path === '/rest/api/2/issue/DEMO-1/comment' && w.body?.body === comment)
      .map(({ method, path, body }) => ({ method, path, body }));
  const once = [
    { method: 'POST', path: '/rest/api/2/issue/DEMO-1/comment', body: { body: comment } },
  ];
  await expect.poll(posted).toEqual(once);
  await page.waitForTimeout(1_500);
  await expect.poll(posted).toEqual(once);
  await expect
    .poll(() => auditFor(orgId, 'DEMO-1'))
    .toEqual(['agent_action.proposed', 'agent_action.approved', 'agent_action.executed']);

  // Rejected: nothing is written
  const other = `Ready for review ${Date.now()}`;
  await ask(page, `Please comment on DEMO-2: ${other}`);
  const second = page.locator('[data-approval]').last();
  await expect(second.getByText(other)).toBeVisible();
  await second.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Understood, I did not post the comment.')).toBeVisible();
  await expect(second.getByText('Rejected')).toBeVisible();
  expect((await jiraWrites(page)).some((w) => w.body?.body === other)).toBe(false);
  await expect
    .poll(() => auditFor(orgId, 'DEMO-2'))
    .toEqual(['agent_action.proposed', 'agent_action.rejected']);

  // The conversation survives a reload (stored server-side), and spend is metered
  await page.reload();
  await expect(page.getByText('Done: the comment is posted.')).toBeVisible();
  await page.goto('/settings/usage');
  await expect(chatKpi(page, '[data-kpi="replies"]')).toHaveText('5');

  // The assistant's number is the dashboard's number
  await page.goto('/');
  await page.getByRole('link', { name: /DEMO Scrum/ }).click();
  await expect(kpi(page, '[data-widget="avg-velocity"]')).toHaveText('19 pts', {
    timeout: 60_000,
  });

  // French UI
  await page.goto('/agent');
  await page.getByRole('button', { name: /Pat Manager/ }).click();
  await page.getByRole('menuitem', { name: 'Français' }).click();
  await expect(page.getByText('Posez une question sur vos tableaux')).toBeVisible();
});

test('a member gets no Jira change proposals and sees only their own usage', async ({
  page,
  browser,
}) => {
  const { orgId } = await setUpWorkspace(page);
  await page.goto('/agent');
  await ask(page, 'What is our velocity?');
  await expect(page.getByText(velocityAnswer)).toBeVisible({ timeout: 60_000 });

  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    const { email } = await signUp(member, 'Sam Member');
    await joinAsMember(email, orgId);

    // Members are offered no Jira write tools, so no approval card can appear.
    await member.goto('/agent');
    const note = `Member note ${Date.now()}`;
    await ask(member, `Please comment on DEMO-4: ${note}`);
    await expect(
      member.getByText(
        'I can answer questions about your boards and act in Jira with your approval.',
      ),
    ).toBeVisible({ timeout: 60_000 });
    await expect(member.locator('[data-approval]')).toHaveCount(0);
    expect((await jiraWrites(member)).some((w) => w.body?.body === note)).toBe(false);
    await expect.poll(() => auditFor(orgId, 'DEMO-4')).toEqual([]);

    // Their own usage only: one answer, one row (theirs), not the admin's
    await member.goto('/settings/usage');
    await expect(member.locator('[data-usage-scope="own"]')).toBeVisible();
    await expect(chatKpi(member, '[data-kpi="replies"]')).toHaveText('1');
    await expect(member.locator('tbody tr')).toHaveCount(1);
    await expect(member.locator('tbody tr')).toContainText('Sam Member');
    await expect(member.getByRole('cell', { name: 'Pat Manager' })).toHaveCount(0);
  } finally {
    await context.close();
  }

  // The admin sees the whole workspace
  await page.goto('/settings/usage');
  await expect(chatKpi(page, '[data-kpi="replies"]')).toHaveText('2');
  await expect(page.locator('tbody tr')).toHaveCount(2);
});

test('the assistant fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await setUpWorkspace(page);
  await page.goto('/agent');
  const noOverflow = () =>
    expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(0);

  await ask(page, 'What is our velocity?');
  await expect(page.getByText(velocityAnswer)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-tool="get_metric"]')).toBeVisible();
  await noOverflow();

  await ask(page, 'Please comment on DEMO-3: Needs a test plan');
  const card = page.locator('[data-approval]').last();
  await expect(card.getByRole('button', { name: 'Approve' })).toBeInViewport();
  await noOverflow();
});
