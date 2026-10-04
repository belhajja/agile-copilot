import { expect, type Page, test } from '@playwright/test';
import { connectionItem, signUpWithWorkspace } from '../helpers';

// The mock Jira serves the demo dataset (packages/jira/src/testing/demo-dataset.ts); the numbers
// below are the ones it is built to produce.
test.describe.configure({ timeout: 180_000 });

async function connectDemoJira(page: Page) {
  await page.goto('/settings/jira');
  await page.getByLabel('Connection name').fill('Demo Jira');
  await page.getByLabel('Jira URL').fill('http://127.0.0.1:4010');
  await page.getByLabel('Data Center / Server').check();
  await page.getByLabel('Personal access token').fill('good-pat');
  await page.getByRole('button', { name: 'Test and save' }).click();
  await expect(connectionItem(page, 'Demo Jira').getByText('Connected')).toBeVisible();
}

const kpi = (page: Page, id: string) =>
  page.locator(`[data-widget="${id}"] [data-slot="card-title"]`);
// The first visit of a route makes `next dev` compile it (recharts, pg-boss…), which can be slow.
const firstCompile = { timeout: 60_000 };

test('select boards, map statuses, sync, and read the Scrum and Kanban dashboards', async ({
  page,
}) => {
  await signUpWithWorkspace(page);
  await connectDemoJira(page);

  // Boards
  await connectionItem(page, 'Demo Jira').getByRole('link', { name: 'Boards' }).click();
  await expect(page.getByText('No boards loaded yet.')).toBeVisible(firstCompile);
  await page.getByRole('button', { name: 'Load boards from Jira' }).click();
  await page.getByLabel('DEMO Scrum').check();
  await page.getByLabel('OPS Kanban').check();
  await page.getByRole('button', { name: 'Save selection' }).click();
  await expect(page.getByText('Board selection saved.')).toBeVisible();

  // Status mapping, suggested from Jira's categories ("Blocked" is a waiting state)
  const scrumMapping = page.locator('[data-board="DEMO Scrum"]');
  const blocked = scrumMapping.locator('[data-status="Blocked"]');
  await expect(blocked.getByRole('combobox')).toHaveValue('in_progress');
  await expect(blocked.getByRole('checkbox')).toBeChecked();
  const review = scrumMapping.locator('[data-status="In Review"]');
  await review.getByRole('checkbox').check();
  await scrumMapping.getByRole('button', { name: 'Save mapping' }).click();
  await expect(page.getByText('Status mapping saved.')).toBeVisible();
  // Undo it so the dashboard numbers below match the default mapping.
  await page
    .locator('[data-board="DEMO Scrum"] [data-status="In Review"]')
    .getByRole('checkbox')
    .uncheck();
  await page
    .locator('[data-board="DEMO Scrum"]')
    .getByRole('button', { name: 'Save mapping' })
    .click();
  // Wait for the second save too, or the sync could run before the mapping is stored.
  await expect(page.getByText('Status mapping saved.')).toBeVisible();

  // Sync (runs in the worker)
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText(/^Synced /)).toBeVisible({ timeout: 90_000 });

  // Scrum dashboard
  await page.goto('/');
  await page.getByRole('link', { name: /DEMO Scrum/ }).click();
  await expect(page.getByRole('heading', { name: 'DEMO Scrum' })).toBeVisible(firstCompile);
  await expect(kpi(page, 'avg-velocity')).toHaveText('19 pts');
  await expect(kpi(page, 'say-do')).toHaveText('95%');
  await expect(kpi(page, 'scope-added')).toHaveText('2 pts');
  await expect(kpi(page, 'carry-over')).toHaveText('1 issue');
  await expect(
    page.locator('[data-widget="velocity"] .recharts-bar-rectangle').first(),
  ).toBeVisible();
  await expect(page.locator('[data-widget="burndown"] .recharts-line').first()).toBeVisible();

  // The flow dashboard of the same board
  await page.getByRole('tab', { name: 'Flow' }).click();
  await expect(
    page.locator('[data-widget="throughput"] .recharts-bar-rectangle').first(),
  ).toBeVisible();

  // Kanban dashboard
  await page.goto('/');
  await page.getByRole('link', { name: /OPS Kanban/ }).click();
  await expect(page.getByRole('tab')).toHaveText(['Flow']);
  await expect(kpi(page, 'throughput-rate')).toHaveText('3 / week');
  await expect(kpi(page, 'cycle-time')).toHaveText('8 days');
  await expect(kpi(page, 'wip')).toHaveText('4 issues');
  await expect(kpi(page, 'flow-efficiency')).toHaveText('83%');
  await expect(page.locator('[data-widget="cfd"] .recharts-area').first()).toBeVisible();
  await expect(page.locator('[data-widget="aging-wip"] tbody tr')).toHaveCount(4);
});
