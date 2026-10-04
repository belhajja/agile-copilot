'use client';

import { Bot, LayoutDashboard, PlugZap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ComponentProps } from 'react';
import { NavMain } from '@/components/nav-main';
import { NavUser } from '@/components/nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';

export function AppSidebar({
  user,
  ...props
}: ComponentProps<typeof Sidebar> & { user: { name: string; email: string } }) {
  const t = useTranslations('nav');
  const items = [
    { title: t('dashboard'), url: '/', icon: LayoutDashboard },
    { title: t('jira'), url: '/settings/jira', icon: PlugZap },
    { title: t('llm'), url: '/settings/llm', icon: Bot },
  ];
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <WorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavMain label={t('platform')} items={items} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
