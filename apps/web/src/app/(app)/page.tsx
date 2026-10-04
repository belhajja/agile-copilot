import { listJiraConnections, listLlmConnections } from '@agile/connections';
import { listSelectedBoards } from '@agile/sync';
import { Bot, ChartColumn, LayoutGrid, PlugZap } from 'lucide-react';
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
import { syncDeps } from '@/server/sync';

export default async function DashboardPage() {
  const actor = await requireActor();
  const t = await getTranslations('dashboard');
  const tb = await getTranslations('boards');
  const deps = connectionDeps();
  const [jira, llm, boards] = await Promise.all([
    listJiraConnections(deps, actor.orgId),
    listLlmConnections(deps, actor.orgId),
    listSelectedBoards(syncDeps(), actor.orgId),
  ]);
  const firstJira = jira.find((c) => c.status === 'ok');
  const steps = [
    {
      href: '/settings/jira',
      icon: PlugZap,
      title: t('connectJira'),
      hint: t('connectJiraHint'),
      done: Boolean(firstJira),
    },
    {
      href: firstJira ? `/settings/jira/${firstJira.id}` : '/settings/jira',
      icon: LayoutGrid,
      title: t('chooseBoards'),
      hint: t('chooseBoardsHint'),
      done: boards.length > 0,
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
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      {boards.length > 0 && (
        <section className="grid gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{t('yourBoards')}</h1>
          <ItemGroup className="gap-3">
            {boards.map((b) => (
              <Item key={b.id} variant="outline" asChild>
                <Link href={`/boards/${b.id}`}>
                  <ItemMedia variant="icon">
                    <ChartColumn />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{b.name}</ItemTitle>
                    <ItemDescription>{b.projectKey}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Badge variant="outline">{tb(`types.${b.type}`)}</Badge>
                  </ItemActions>
                </Link>
              </Item>
            ))}
          </ItemGroup>
        </section>
      )}
      <section className="grid gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">{t('title')}</h2>
        <ItemGroup className="gap-3">
          {steps.map((s) => (
            <Item key={s.title} variant="outline" asChild>
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
      </section>
    </div>
  );
}
