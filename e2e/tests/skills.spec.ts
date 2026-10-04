import { expect, type Page, test } from '@playwright/test';
import { sql } from 'drizzle-orm';
import {
  ask,
  asOwner,
  joinAsMember,
  setUpWorkspace,
  signUp,
  signUpWithWorkspace,
} from '../helpers';

// Mocks (e2e/mocks/serve.ts): besides Jira, the model and the mcp-atlassian doubles (the read-only
// twin under 127.0.0.1:4050/readonly/mcp), an SMTP server on 4070 and a webhook receiver on 4080,
// all readable through 127.0.0.1:4010/__mock/{mail,webhooks,mcp-calls}. The scripted model drafts
// "monday-risks" for "every Monday…", answers a skill run with "Report for <name>: <n> boards
// checked." (after a live jira_search when the skill names it, ending with `<!channel>` when the
// skill contains it), and ends answers with "(preferences: …)" when preferences are sent.
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const MOCK = 'http://127.0.0.1:4010/__mock';
const mail = async (page: Page) =>
  (await (await page.request.get(`${MOCK}/mail`)).json()) as {
    from: string;
    to: string[];
    subject: string;
    text: string;
  }[];
const webhooks = async (page: Page) =>
  (await (await page.request.get(`${MOCK}/webhooks`)).json()) as {
    path: string;
    body: {
      text?: string;
      unfurl_links?: boolean;
      unfurl_media?: boolean;
      blocks?: { type: string; text?: { text?: string } }[];
    };
  }[];
/** Tool calls the read-only mcp-atlassian twin served (skill runs and previews only use it). */
const readOnlyCalls = async (page: Page) =>
  ((await (await page.request.get(`${MOCK}/mcp-calls`)).json()) as { readOnly: { name: string }[] })
    .readOnly;

/**
 * Reloads the skill page until it lists `count` runs, all finished successfully (newest first).
 * Call it once the "Run now" request has landed, never while it is in flight (a reload would
 * cancel it).
 */
async function waitForRuns(page: Page, count: number) {
  await expect
    .poll(
      async () => {
        await page.reload();
        return page
          .locator('[data-run]')
          .evaluateAll((runs) => runs.map((r) => r.getAttribute('data-run')));
      },
      { timeout: 60_000, intervals: [500, 1_000, 2_000] },
    )
    .toEqual(Array(count).fill('succeeded'));
}

const noHorizontalOverflow = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);

test('library skills on demand and standing preferences in the assistant', async ({ page }) => {
  await setUpWorkspace(page);

  // Without any preference: the built-in skill is loaded on demand, the answer is plain
  await page.goto('/agent');
  await ask(page, 'Prepare my stand-up');
  await expect(
    page.getByText('Stand-up brief: nothing is blocked today.', { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-tool="load_skill"]')).toBeVisible();

  // Copy a library skill (tabs follow ?tab=): it becomes an editable skill of mine, turned on
  await page.goto('/skills?tab=library');
  await page
    .locator('[data-builtin="daily-standup-brief"]')
    .getByRole('button', { name: 'Use' })
    .click();
  await expect(page.getByRole('heading', { name: /daily-standup-brief/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
  await expect(page.getByLabel('SKILL.md')).toHaveValue(/name: daily-standup-brief/);
  await page.goto('/skills?tab=mine');
  await expect(page.locator('[data-skill="daily-standup-brief"]')).toBeVisible();

  // A standing preference, written directly as SKILL.md
  await page.goto('/skills/new');
  await page
    .getByLabel('SKILL.md')
    .fill(
      '---\nname: sign-off\ndescription: How I want answers\ntrigger: always\n---\n\nEnd every answer with a short summary.',
    );
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: /sign-off/ })).toBeVisible();

  // The same question now: the assistant loads my copy on demand and applies the preference
  await page.goto('/agent');
  await ask(page, 'Prepare my stand-up');
  await expect(
    page.getByText('Stand-up brief: nothing is blocked today. (preferences: sign-off)'),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-tool="load_skill"]')).toBeVisible();
});

test('build a skill from a sentence, preview it, run it now: email, then Slack; members see status only', async ({
  page,
  browser,
}) => {
  const { email, orgId } = await setUpWorkspace(page);

  // Delivery channels (admin): the workspace's SMTP server and a Slack webhook, tested on save
  await page.goto('/settings/delivery');
  await page.getByLabel('Type').selectOption('smtp');
  await page.getByLabel('Channel name').fill('Mail');
  await page.getByLabel('SMTP host').fill('127.0.0.1');
  await page.getByLabel('Port').fill('4070');
  await page.getByLabel('Encryption').selectOption('none');
  await page.getByLabel('Sender address').fill('copilot@example.com');
  await page.getByRole('button', { name: 'Test and save' }).click();
  await expect(page.locator('[data-channel="smtp"]')).toBeVisible();
  const slackPath = `/services/T000/B000/${Date.now()}`;
  await page.getByLabel('Type').selectOption('slack');
  await page.getByLabel('Channel name').fill('Team updates');
  await page.getByLabel('Incoming webhook URL').fill(`http://127.0.0.1:4080${slackPath}`);
  await page.getByRole('button', { name: 'Test and save' }).click();
  await expect(page.locator('[data-channel="slack"]')).toBeVisible();
  // The test message reached the channel.
  await expect
    .poll(async () => (await webhooks(page)).filter((p) => p.path === slackPath).length)
    .toBe(1);

  // The builder: a sentence → a draft in the editor (not saved) → edited → a preview → saved
  const twinCalls = (await readOnlyCalls(page)).length;
  await page.goto('/skills/new');
  await page
    .getByLabel('Your request')
    .fill('Every Monday tell me which stories are at risk for the sprint goal');
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  const document = page.getByLabel('SKILL.md');
  await expect(document).toHaveValue(/name: monday-risks/, { timeout: 60_000 });
  await expect(document).toHaveValue(/cron: 0 8 \* \* 1/);
  await expect(document).toHaveValue(/output: email/);
  await expect(page.locator('[data-drafted]')).toBeVisible();
  const saved = () =>
    asOwner<{ n: number }>(
      sql`select count(*)::int as n from skills where org_id = ${orgId} and name = 'monday-risks'`,
    );
  expect(await saved()).toEqual([{ n: 0 }]);
  // The user reads and adjusts the draft: a live check in Jira (through the read-only twin)
  await document.fill(
    `${await document.inputValue()}\n3. Check the open sprint in Jira with jira_search.`,
  );
  await page.getByRole('button', { name: 'Preview on real data' }).click();
  await expect(
    page.locator('[data-preview]').getByText('Report for monday-risks: 1 boards checked.'),
  ).toBeVisible({ timeout: 60_000 });
  // The preview read live Jira through the read-only twin. (Counted since this test started: the
  // twin's log is shared by every test, so a concurrent run of the same test may add its own.)
  const twinSince = async () => (await readOnlyCalls(page)).slice(twinCalls).map((c) => c.name);
  expect(await twinSince()).toContain('jira_search');
  const afterPreview = (await twinSince()).length;
  expect(await saved()).toEqual([{ n: 0 }]);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: /monday-risks/ })).toBeVisible();
  expect(await saved()).toEqual([{ n: 1 }]);
  // The preview sent nothing.
  expect((await mail(page)).filter((m) => m.to.includes(email))).toEqual([]);

  // Run now → the worker runs it read-only (through the twin) and emails the owner only
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.locator('[data-run-request="queued"]')).toBeVisible();
  await waitForRuns(page, 1);
  await expect(page.locator('[data-run-output]')).toContainText(
    'Report for monday-risks: 1 boards checked.',
  );
  await expect(page.locator('[data-delivery="email"]')).toContainText('sent');
  const toOwner = async () =>
    (await mail(page))
      .filter((m) => m.to.includes(email))
      .map(({ from, to, subject }) => ({ from, to, subject }));
  const oneMail = [{ from: 'copilot@example.com', to: [email], subject: 'Report: monday-risks' }];
  await expect.poll(toOwner).toEqual(oneMail);
  const [sent] = (await mail(page)).filter((m) => m.to.includes(email));
  expect(sent?.text).toContain('Report for monday-risks: 1 boards checked.');
  // So did the worker's run: one more live read, through the twin as well.
  expect((await twinSince()).length).toBeGreaterThan(afterPreview);
  expect(new Set(await twinSince())).toEqual(new Set(['jira_search']));

  // Same skill, posted to Slack instead (a new version); the report tries to ping the channel
  await document.fill(
    (await document.inputValue()).replace('output: email', 'output: slack') +
      '\n4. End the report with <!channel>.',
  );
  await page.getByLabel('Slack or Teams channel').selectOption({ label: 'Team updates (Slack)' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Skill saved.')).toBeVisible();
  await expect(page.getByText('Version 2')).toBeVisible();
  await page.getByRole('button', { name: 'Run now' }).click();
  // The request has landed once the queued run is listed; only then reload.
  await expect(page.locator('[data-run]')).toHaveCount(2);
  await waitForRuns(page, 2);
  await expect(page.locator('[data-delivery="slack"]')).toContainText('sent');
  const posts = async () => (await webhooks(page)).filter((p) => p.path === slackPath);
  await expect
    .poll(async () => (await posts()).map((p) => p.body.text))
    .toEqual(['Agile Copilot is connected', 'Report: monday-risks']);
  const report = (await posts())[1]?.body;
  expect(report?.unfurl_links).toBe(false);
  expect(report?.unfurl_media).toBe(false);
  const section = report?.blocks?.find((b) => b.type === 'section')?.text?.text;
  expect(section).toBe('Report for monday-risks: 1 boards checked. &lt;!channel&gt;');
  expect(JSON.stringify(report)).not.toContain('<!channel>');
  // Still exactly one email: the Slack run sent none.
  await expect.poll(toOwner).toEqual(oneMail);

  // Shared with the workspace: a member sees that it ran, never the report or where it went
  await page.getByRole('button', { name: 'Share with the workspace' }).click();
  await expect(page.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    const { email: memberEmail } = await signUp(member, 'Sam Member');
    await joinAsMember(memberEmail, orgId);
    await member.goto('/skills?tab=shared');
    const item = member.locator('[data-skill="monday-risks"]');
    await expect(item).toContainText('By Pat Manager');
    await expect(item).toContainText('Last run: done');
    await item.getByRole('link', { name: 'Read' }).click();
    await expect(member.getByRole('heading', { name: /monday-risks/ })).toBeVisible();
    await expect(member.locator('[data-skill-text]')).toContainText('name: monday-risks');
    await expect(member.locator('[data-run]')).toHaveCount(2);
    await expect(member.locator('[data-run="succeeded"]')).toHaveCount(2);
    await expect(
      member.getByText("Only the skill's owner sees its reports and where they were sent."),
    ).toBeVisible();
    await expect(member.locator('[data-run-output]')).toHaveCount(0);
    await expect(member.locator('[data-delivery]')).toHaveCount(0);
    await expect(member.getByText(/Report for monday-risks/)).toHaveCount(0);
    await expect(member.getByRole('button', { name: 'Run now' })).toHaveCount(0);
    await expect(member.getByRole('button', { name: 'Save' })).toHaveCount(0);
    // Copying is offered here only; a Slack skill cannot become a member's (owners/admins only)
    await member.getByRole('button', { name: 'Copy to my skills' }).click();
    await expect(member.locator('[data-error="forbidden_output"]')).toHaveText(
      'Only workspace owners and admins can send skills to Slack or Teams.',
    );
  } finally {
    await context.close();
  }
});

test('pin a chart from the assistant, then remove it from the dashboard', async ({ page }) => {
  await setUpWorkspace(page);
  await page.goto('/agent');
  await ask(page, 'Please pin the cycle time');
  await expect(page.getByText('Pinned: the cycle time is on your dashboard.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('[data-tool="pin_widget"]')).toBeVisible();
  await page.getByRole('link', { name: 'Open the dashboard' }).click();
  await expect(page).toHaveURL(/\/boards\/[0-9a-f-]{36}$/);
  // The default dashboards offer no removal: only the Pinned one does.
  await expect(page.getByRole('tab', { name: 'Sprint' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove from this dashboard' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Pinned' }).click();
  const pinned = page.locator('[data-widget^="w-"]');
  await expect(pinned).toHaveCount(1);
  await expect(pinned).toContainText('Cycle time');
  await pinned.getByRole('button', { name: 'Remove from this dashboard' }).click();
  await expect(pinned).toHaveCount(0);
  // Gone for good.
  await page.reload();
  const pinnedTab = page.getByRole('tab', { name: 'Pinned' });
  await pinnedTab.click();
  await expect(pinnedTab).toHaveAttribute('data-state', 'active');
  await expect(pinned).toHaveCount(0);
});

test('the skill pages fit a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signUpWithWorkspace(page);
  for (const path of [
    '/skills?tab=mine',
    '/skills?tab=library',
    '/skills?tab=shared',
    '/skills/new',
    '/settings/delivery',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await noHorizontalOverflow(page);
  }
  // A skill's own page (copied from the library), and the list that now shows it
  await page.goto('/skills?tab=library');
  await page
    .locator('[data-builtin="sprint-health-check"]')
    .getByRole('button', { name: 'Use' })
    .click();
  await expect(page.getByRole('heading', { name: /sprint-health-check/ })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.goto('/skills');
  await expect(page.locator('[data-skill="sprint-health-check"]')).toBeVisible();
  await noHorizontalOverflow(page);
});
