'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Fragment } from 'react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

type Crumb =
  | 'dashboard'
  | 'settings'
  | 'jira'
  | 'llm'
  | 'usage'
  | 'boards'
  | 'board'
  | 'agent'
  | 'skills'
  | 'skill'
  | 'delivery'
  | 'account'
  | 'billing';

const TRAILS: Record<string, Crumb[]> = {
  '/': ['dashboard'],
  '/settings/jira': ['settings', 'jira'],
  '/settings/llm': ['settings', 'llm'],
  '/settings/usage': ['settings', 'usage'],
  '/settings/delivery': ['settings', 'delivery'],
  '/settings/account': ['account'],
  '/settings/billing': ['settings', 'billing'],
  '/skills': ['skills'],
};

/** Exact pages first, then the dynamic ones (/settings/jira/<id>, /boards/<id>). */
function trailFor(pathname: string): Crumb[] {
  if (TRAILS[pathname]) return TRAILS[pathname];
  if (pathname.startsWith('/settings/jira/')) return ['settings', 'jira', 'boards'];
  if (pathname.startsWith('/boards/')) return ['dashboard', 'board'];
  if (pathname === '/agent' || pathname.startsWith('/agent/')) return ['agent'];
  if (pathname.startsWith('/skills/')) return ['skills', 'skill'];
  return [];
}

export function PageBreadcrumb() {
  const t = useTranslations('nav');
  const trail = trailFor(usePathname());
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {trail.map((key, i) => (
          <Fragment key={key}>
            {i > 0 && <BreadcrumbSeparator className="hidden md:block" />}
            <BreadcrumbItem className={i < trail.length - 1 ? 'hidden md:block' : undefined}>
              <BreadcrumbPage>{t(key)}</BreadcrumbPage>
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
