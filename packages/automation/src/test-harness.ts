import { startAgentHarness } from '@agile/agent/testing';
import { member as memberTable, organization, user } from '@agile/db';
import type { MockScript } from '@agile/llm/testing';
import { createDeliveryChannel, DIGEST_LABELS } from '@agile/notify';
import { startMockSmtp, startMockWebhook } from '@agile/notify/testing';
import { member, owner } from '@agile/sync/testing';
import type { AutomationDeps } from './deps';

/**
 * The agent harness (Postgres, demo boards synced, mock LLM and Jira) plus what background runs
 * need: real workspace rows (the owner's role and email are read at run time), an SMTP server and
 * a Slack webhook, both saved as the workspace's delivery channels.
 */
export async function startAutomationHarness(opts: { script?: MockScript } = {}) {
  const h = await startAgentHarness(opts);
  const smtp = await startMockSmtp();
  const hook = await startMockWebhook();
  const now = new Date();
  await h.rawDb.insert(organization).values({
    id: 'org_a',
    name: 'Acme',
    slug: 'acme',
    createdAt: now,
  });
  await h.rawDb.insert(user).values([
    { id: owner().userId, name: 'Pat Owner', email: 'pat@example.com' },
    { id: member().userId, name: 'Mo Member', email: 'mo@example.com' },
  ]);
  await h.rawDb.insert(memberTable).values([
    { id: 'm1', organizationId: 'org_a', userId: owner().userId, role: 'owner', createdAt: now },
    { id: 'm2', organizationId: 'org_a', userId: member().userId, role: 'member', createdAt: now },
  ]);
  const testMessage = { title: DIGEST_LABELS.en.testTitle, text: DIGEST_LABELS.en.testText };
  const email = await createDeliveryChannel(
    h.deps,
    owner(),
    {
      kind: 'smtp',
      name: 'Mail',
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none',
      from: 'copilot@example.com',
    },
    { testMessage },
  );
  const slack = await createDeliveryChannel(
    h.deps,
    owner(),
    { kind: 'slack', name: 'Team', url: `${hook.url}/services/T/B/x` },
    { testMessage },
  );
  // Works when saved; tests then add its path to `hook.failing` to break it at delivery time.
  const broken = await createDeliveryChannel(
    h.deps,
    owner(),
    { kind: 'slack', name: 'Broken', url: `${hook.url}/services/T/B/broken` },
    { testMessage },
  );
  if (!email.ok || !slack.ok || !broken.ok) throw new Error('channel setup failed');
  const deps: AutomationDeps = { ...h.deps, appUrl: 'http://localhost:3200', dailyLimit: 50 };
  return {
    ...h,
    smtp,
    hook,
    deps,
    slackChannelId: slack.channel.id,
    brokenChannelId: broken.channel.id,
    stop: async () => {
      await smtp.close();
      await hook.close();
      await h.stop();
    },
  };
}
