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

type Crumb = 'dashboard' | 'settings' | 'jira' | 'llm' | 'boards' | 'board';

const TRAILS: Record<string, Crumb[]> = {
  '/': ['dashboard'],
  '/settings/jira': ['settings', 'jira'],
  '/settings/llm': ['settings', 'llm'],
};

/** Exact pages first, then the dynamic ones (/settings/jira/<id>, /boards/<id>). */
function trailFor(pathname: string): Crumb[] {
  if (TRAILS[pathname]) return TRAILS[pathname];
  if (pathname.startsWith('/settings/jira/')) return ['settings', 'jira', 'boards'];
  if (pathname.startsWith('/boards/')) return ['dashboard', 'board'];
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
