import { listJiraConnections, listLlmConnections } from '@agile/connections';
import { Bot, PlugZap } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { connectionDeps, requireActor } from '@/server/context';

export default async function DashboardPage() {
  const actor = await requireActor();
  const t = await getTranslations('dashboard');
  const deps = connectionDeps();
  const [jira, llm] = await Promise.all([
    listJiraConnections(deps, actor.orgId),
    listLlmConnections(deps, actor.orgId),
  ]);
  const steps = [
    {
      href: '/settings/jira',
      icon: PlugZap,
      title: t('connectJira'),
      hint: t('connectJiraHint'),
      done: jira.some((c) => c.status === 'ok'),
    },
    {
      href: '/settings/llm',
      icon: Bot,
      title: t('connectLlm'),
      hint: t('connectLlmHint'),
      done: llm.some((c) => c.status === 'ok'),
    },
  ];
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <ItemGroup className="gap-3">
        {steps.map((s) => (
          <Item key={s.href} variant="outline" asChild>
            <Link href={s.href}>
              <ItemMedia variant="icon">
                <s.icon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{s.title}</ItemTitle>
                <ItemDescription>{s.hint}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Badge variant={s.done ? 'default' : 'secondary'}>
                  {s.done ? t('done') : t('todo')}
                </Badge>
              </ItemActions>
            </Link>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
}
