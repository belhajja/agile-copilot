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

const TRAILS: Record<string, ('dashboard' | 'settings' | 'jira' | 'llm')[]> = {
  '/': ['dashboard'],
  '/settings/jira': ['settings', 'jira'],
  '/settings/llm': ['settings', 'llm'],
};

export function PageBreadcrumb() {
  const t = useTranslations('nav');
  const trail = TRAILS[usePathname()] ?? [];
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
