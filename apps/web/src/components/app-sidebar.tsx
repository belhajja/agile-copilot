'use client';

import {
  Bot,
  CreditCard,
  FileClock,
  LayoutDashboard,
  MessagesSquare,
  Plug,
  PlugZap,
  ReceiptText,
  Send,
  Settings2,
  Sparkles,
  Users,
} from 'lucide-react';
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
  billing,
  ...props
}: ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string };
  /** SaaS with Stripe configured: show the Billing page. */
  billing: boolean;
}) {
  const t = useTranslations('nav');
  const items = [
    { title: t('dashboard'), url: '/', icon: LayoutDashboard },
    { title: t('agent'), url: '/agent', icon: MessagesSquare },
    { title: t('skills'), url: '/skills', icon: Sparkles },
    { title: t('jira'), url: '/settings/jira', icon: PlugZap },
    { title: t('llm'), url: '/settings/llm', icon: Bot },
    { title: t('delivery'), url: '/settings/delivery', icon: Send },
    { title: t('usage'), url: '/settings/usage', icon: ReceiptText },
    { title: t('members'), url: '/settings/members', icon: Users },
    { title: t('workspace'), url: '/settings/workspace', icon: Settings2 },
    { title: t('audit'), url: '/settings/audit', icon: FileClock },
    { title: t('mcp'), url: '/settings/mcp', icon: Plug },
    ...(billing ? [{ title: t('billing'), url: '/settings/billing', icon: CreditCard }] : []),
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
