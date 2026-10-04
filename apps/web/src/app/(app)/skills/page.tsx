import { BUILTIN_SKILLS, listSkills, type SkillView } from '@agile/skills';
import { Library, Plus, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireActor, services } from '@/server/context';
import { copyBuiltinSkillAction } from './actions';
import { SkillBadges } from './skill-badges';

/** The user's skills, the built-in library and the skills members shared with the workspace. */
export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requireActor();
  const t = await getTranslations('skills');
  const format = await getFormatter();
  const { error } = await searchParams;
  const { mine, shared } = await listSkills(services().db, actor);
  const now = new Date();

  const lastRun = (s: SkillView) =>
    s.lastRun
      ? t('lastRun', {
          status: t(`runStatus.${s.lastRun.status}`),
          when: s.lastRun.finishedAt ? format.relativeTime(s.lastRun.finishedAt, now) : '',
        })
      : null;

  const item = (s: SkillView, actions: React.ReactNode) => (
    <Item key={s.id} variant="outline" data-skill={s.name}>
      <ItemMedia variant="icon">
        <Sparkles />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex-wrap">
          <Link href={`/skills/${s.id}`} className="hover:underline">
            {s.name}
          </Link>
          <SkillBadges skill={s} />
        </ItemTitle>
        <ItemDescription>{s.description}</ItemDescription>
        {s.ownerUserId !== actor.userId && (
          <p className="text-sm text-muted-foreground">
            {t('by', { name: s.ownerName ?? t('formerMember') })}
          </p>
        )}
        {lastRun(s) && <p className="text-sm text-muted-foreground">{lastRun(s)}</p>}
      </ItemContent>
      <ItemActions className="flex-wrap">{actions}</ItemActions>
    </Item>
  );

  const open = (s: SkillView, label: string) => (
    <Button asChild variant="outline" size="sm">
      <Link href={`/skills/${s.id}`}>{label}</Link>
    </Button>
  );

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground">{t('intro')}</p>
        </div>
        <Button asChild>
          <Link href="/skills/new">
            <Plus />
            {t('new')}
          </Link>
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {t.has(`errors.${error}`) ? t(`errors.${error}`) : t('errors.unknown')}
          </AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue={mine.length > 0 ? 'mine' : 'library'}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="mine">{t('tabs.mine')}</TabsTrigger>
          <TabsTrigger value="library">{t('tabs.library')}</TabsTrigger>
          <TabsTrigger value="shared">{t('tabs.shared')}</TabsTrigger>
        </TabsList>
        <TabsContent value="mine" className="mt-4">
          {mine.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Sparkles />
                </EmptyMedia>
                <EmptyTitle>{t('empty')}</EmptyTitle>
                <EmptyDescription>{t('emptyHint')}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild variant="outline">
                  <Link href="/skills/new">{t('new')}</Link>
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <ItemGroup className="gap-3">{mine.map((s) => item(s, open(s, t('open'))))}</ItemGroup>
          )}
        </TabsContent>
        <TabsContent value="library" className="mt-4">
          <ItemGroup className="gap-3">
            {BUILTIN_SKILLS.map((b) => (
              <Item key={b.key} variant="outline" data-builtin={b.key}>
                <ItemMedia variant="icon">
                  <Library />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{t(`library.${b.key}.title`)}</ItemTitle>
                  <ItemDescription>{t(`library.${b.key}.description`)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <form action={copyBuiltinSkillAction.bind(null, b.key)}>
                    <Button variant="outline" size="sm">
                      {t('use')}
                    </Button>
                  </form>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
          <p className="mt-3 text-sm text-muted-foreground">{t('libraryHint')}</p>
        </TabsContent>
        <TabsContent value="shared" className="mt-4">
          {shared.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noShared')}</p>
          ) : (
            <ItemGroup className="gap-3">
              {shared.map((s) => item(s, open(s, t('read'))))}
            </ItemGroup>
          )}
          <p className="mt-3 text-sm text-muted-foreground">{t('sharedHint')}</p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
